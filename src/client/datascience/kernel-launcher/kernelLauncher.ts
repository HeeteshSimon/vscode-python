// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import { ChildProcess } from 'child_process';
import { inject, injectable, named } from 'inversify';
import * as portfinder from 'portfinder';
import { promisify } from 'util';
import * as uuid from 'uuid/v4';
import { Event, EventEmitter } from 'vscode';
import { InterpreterUri } from '../../common/installer/types';
import { traceInfo, traceWarning } from '../../common/logger';
import { IFileSystem, TemporaryFile } from '../../common/platform/types';
import { IPythonExecutionFactory } from '../../common/process/types';
import { IOutputChannel } from '../../common/types';
import { createDeferred, Deferred } from '../../common/utils/async';
import * as localize from '../../common/utils/localize';
import { noop } from '../../common/utils/misc';
import { IInterpreterService } from '../../interpreter/contracts';
import { JUPYTER_OUTPUT_CHANNEL } from '../constants';
import { IJupyterKernelSpec } from '../types';
import { findIndexOfConnectionFile } from './kernelFinder';
import { IKernelConnection, IKernelFinder, IKernelLauncher, IKernelProcess } from './types';

// Launches and disposes a kernel process given a kernelspec and a resource or python interpreter.
// Exposes connection information and the process itself.
class KernelProcess implements IKernelProcess {
    private _process?: ChildProcess;
    private connectionFile?: TemporaryFile;
    private readyPromise: Deferred<void>;
    private exitEvent: EventEmitter<number | null> = new EventEmitter<number | null>();

    // This promise is resolved when the launched process is ready to get JMP messages
    public get ready(): Promise<void> {
        return this.readyPromise.promise;
    }

    // This event is triggered if the process is exited
    public get exited(): Event<number | null> {
        return this.exitEvent.event;
    }

    public get kernelSpec(): Readonly<IJupyterKernelSpec> {
        return this._kernelSpec;
    }
    public get connection(): Readonly<IKernelConnection> {
        return this._connection;
    }

    constructor(
        private executionFactory: IPythonExecutionFactory,
        private interpreterService: IInterpreterService,
        private file: IFileSystem,
        private outputChannel: IOutputChannel,
        private _connection: IKernelConnection,
        private _kernelSpec: IJupyterKernelSpec
    ) {
        this.readyPromise = createDeferred<void>();
    }

    public async launch(): Promise<void> {
        this.connectionFile = await this.file.createTemporaryFile('.json');
        const args = [...this._kernelSpec.argv];
        await this.file.writeFile(this.connectionFile.filePath, JSON.stringify(this._connection), {
            encoding: 'utf-8',
            flag: 'w'
        });

        // Inclide the conenction file in the arguments and remove the first argument which should be python
        const indexOfConnectionFile = findIndexOfConnectionFile(this._kernelSpec);
        if (indexOfConnectionFile === -1) {
            throw new Error(`Connection file not found in kernelspec json args, ${args.join(' ')}`);
        }
        args[indexOfConnectionFile] = this.connectionFile.filePath;
        // First part of argument is always the executable.
        const pythonPath = this._kernelSpec.metadata?.interpreter?.path || args[0];
        args.shift();

        // Use that to find the matching interpeter.
        const matchingInterpreter = await this.interpreterService.getInterpreterDetails(pythonPath);

        // Use that to create an execution service with the correct environment.
        const executionService = await this.executionFactory.createActivatedEnvironment({
            resource: undefined,
            interpreter: matchingInterpreter
        });

        this.outputChannel.appendLine(localize.DataScience.connectingIPyKernel());

        // Then launch that process, also merging in the environment in the kernelspec
        const exeObs = executionService.execObservable(args, { extraVariables: this._kernelSpec.env });

        if (exeObs.proc) {
            exeObs.proc!.on('exit', (exitCode) => {
                // tslint:disable-next-line: messages-must-be-localized
                this.outputChannel.appendLine(`Kernel died with exit code: ${exitCode}`);
                traceInfo('KernelProcess Exit', `Exit - ${exitCode}`);
                if (!this.readyPromise.completed) {
                    this.readyPromise.reject(new Error(localize.DataScience.rawKernelProcessExitBeforeConnect()));
                }
                this.exitEvent.fire(exitCode);
            });
        } else {
            traceInfo('KernelProcess failed to launch');
            this.readyPromise.reject(new Error(localize.DataScience.rawKernelProcessNotStarted()));
        }
        exeObs.out.subscribe((output) => {
            if (output.source === 'stderr') {
                traceWarning(`StdErr from Kernel Process ${output.out}`);
                this.outputChannel.appendLine(output.out);
            } else {
                // Search for --existing this is the message that will indicate that our kernel is actually
                // up and started from stdout
                //    To connect another client to this kernel, use:
                //    --existing /var/folders/q7/cn8fg6s94fgdcl0h7rbxldf00000gn/T/tmp-16231TOL2dgBoWET1.json
                // Is this going to work with non-python?
                if (!this.readyPromise.completed && output.out.includes('--existing')) {
                    this.readyPromise.resolve();
                    this.outputChannel.appendLine(localize.DataScience.connectedToIPyKernel());
                } else if (this.readyPromise.resolved) {
                    this.outputChannel.appendLine(output.out);
                }
                traceInfo(output.out);
            }
        });
        this._process = exeObs.proc;
    }

    public dispose() {
        try {
            this._process?.kill();
            this.connectionFile?.dispose();
        } catch {
            noop();
        }
    }
}

// Launches and returns a kernel process given a resource or python interpreter.
// If the given interpreter is undefined, it will try to use the selected interpreter.
// If the selected interpreter doesn't have a kernel, it will find a kernel on disk and use that.
@injectable()
export class KernelLauncher implements IKernelLauncher {
    constructor(
        @inject(IKernelFinder) private kernelFinder: IKernelFinder,
        @inject(IPythonExecutionFactory) private executionFactory: IPythonExecutionFactory,
        @inject(IInterpreterService) private interpreterService: IInterpreterService,
        @inject(IFileSystem) private file: IFileSystem,
        @inject(IOutputChannel) @named(JUPYTER_OUTPUT_CHANNEL) private jupyterOutput: IOutputChannel
    ) {}

    public async launch(
        interpreterUri: InterpreterUri,
        kernelName?: string | IJupyterKernelSpec
    ): Promise<IKernelProcess> {
        let kernelSpec: IJupyterKernelSpec;
        if (!kernelName || typeof kernelName === 'string') {
            // string or undefined
            kernelSpec = await this.kernelFinder.findKernelSpec(interpreterUri, kernelName);
        } else {
            // IJupyterKernelSpec
            kernelSpec = kernelName;
        }

        const connection = await this.getKernelConnection();
        const kernelProcess = new KernelProcess(
            this.executionFactory,
            this.interpreterService,
            this.file,
            this.jupyterOutput,
            connection,
            kernelSpec
        );
        await kernelProcess.launch();
        return kernelProcess;
    }

    private async getKernelConnection(): Promise<IKernelConnection> {
        const getPorts = promisify(portfinder.getPorts);
        const ports = await getPorts(5, { host: '127.0.0.1', port: 9000 });

        return {
            version: 1,
            key: uuid(),
            signature_scheme: 'hmac-sha256',
            transport: 'tcp',
            ip: '127.0.0.1',
            hb_port: ports[0],
            control_port: ports[1],
            shell_port: ports[2],
            stdin_port: ports[3],
            iopub_port: ports[4]
        };
    }
}
