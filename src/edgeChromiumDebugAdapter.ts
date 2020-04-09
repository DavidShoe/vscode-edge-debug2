
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as errors from './errors';

import * as events from 'events';

import { ChromeDebugAdapter } from './chromeDebugAdapter';
import { ILaunchRequestArgs } from './chromeDebugInterfaces';
import { IWebViewConnectionInfo } from './edgeChromiumDebugInterfaces';

import { ITelemetryPropertyCollector, utils as coreUtils, utils, chromeUtils, chromeConnection } from 'vscode-chrome-debug-core';
import { assert } from 'console';
import { ChromeConnection } from 'vscode-chrome-debug-core/lib/src/chrome/chromeConnection';
import { Url } from 'url';

export class EdgeChromiumDebugAdapter extends ChromeDebugAdapter {
    private _isDebuggerUsingWebView: boolean;


    private _webviewPipeServerList: Array<net.Server> = [];

    //private _webviewPipeServer: net.Server;

    private _targetUrl: string;


    public async launch(args: ILaunchRequestArgs, telemetryPropertyCollector: ITelemetryPropertyCollector, seq?: number) {
        let attachToWebView = false;
        let webViewCreatedCallback: (port: number) => void;
        const webViewReadyToAttach = new Promise<number>((resolve, reject) => {
            webViewCreatedCallback = resolve;
        });

        if (args.useWebView) {
            if (!args.runtimeExecutable) {
                // Users must specify the host application via runtimeExecutable when using webview
                return errors.incorrectFlagMessage('runtimeExecutable', 'Must be set when using \'useWebView\'');
            }

            const webViewTelemetry = (args.useWebView === 'advanced' ? 'advanced' : 'true');
            telemetryPropertyCollector.addTelemetryProperty('useWebView', webViewTelemetry);
            this._isDebuggerUsingWebView = true;

            if (!args.noDebug) {
                // Initialize WebView debugging environment variables
                args.env = args.env || {};

                if (args.useWebView === 'advanced') {
                    // Advanced scenarios should use port 0 by default since we expect the callback to inform us of the correct port
                    if (!args.port || args.port === 2015) {
                        args.port = 0;
                    }

                    // Create the webview server that will inform us of webview creation events
                    const pipeName = await this.createWebViewServer(args, webViewCreatedCallback);
                    args.env['WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER'] = pipeName;
                } else {
                    // For normal scenarios use the port specified or 2015 by default
                    args.port = args.port || 2015;
                    if (!args.userDataDir) {
                        // Also override the userDataDir to force remote debugging to be enabled
                        args.userDataDir = path.join(os.tmpdir(), `vscode-edge-debug-userdatadir_${args.port}`);
                    }
                    webViewCreatedCallback(args.port);
                }

                if (args.userDataDir) {
                    // WebView should not force a userDataDir (unless user specified one) so that we don't disrupt
                    // the expected behavior of the host application.
                    args.env['WEBVIEW2_USER_DATA_FOLDER'] = args.userDataDir.toString();
                }
                args.env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = `--remote-debugging-port=${args.port}`;
                args.env['WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER'] = 'true';
            }

            // To ensure the ChromeDebugAdapter does not override the launchUrl for WebView we force noDebug=true.
            attachToWebView = !args.noDebug;
            args.noDebug = true;
        }

        await super.launch(args, telemetryPropertyCollector, seq);
        if (attachToWebView) {
            const port = await webViewReadyToAttach;

            // If we are debugging a WebView, we need to attach to it after launch.
            // Since the ChromeDebugAdapter will have been called with noDebug=true,
            // it will not have auto attached during the super.launch() call.
            this.doAttach(port, this.getWebViewLaunchUrl(args), args.address, args.timeout, undefined, args.extraCRDPChannelPort);
        }
    }

    public shutdown() {
        super.shutdown();

        for (var key in this._webviewPipeServerList)
        {
            if (this._webviewPipeServerList[key] != null)
            {
                this._webviewPipeServerList[key].close();
            }
        }


        // // Clean up the pipe server
        // if (this._webviewPipeServer) {
        //     this._webviewPipeServer.close();
        // }
    }

    protected async doAttach(port: number, targetUrl?: string, address?: string, timeout?: number, websocketUrl?: string, extraCRDPChannelPort?: number) {
        await super.doAttach(port, targetUrl, address, timeout, websocketUrl, extraCRDPChannelPort);

        if (this._isDebuggerUsingWebView) {
            // For WebViews we must issue the runIfWaitingForDebugger command once we are attached, to resume script execution
            this.chrome.Runtime.runIfWaitingForDebugger();
        }
    }

    protected runConnection(): Promise<void>[] {
        if (!this._isDebuggerUsingWebView) {
            return super.runConnection();
        } else {
            // For WebView we must not call super.runConnection() since that will cause the execution to resume before we are ready.
            // Instead we strip out the call to _chromeConnection.run() and call runIfWaitingForDebugger() once attach is complete.
            return [
                this.chrome.Console.enable()
                    .catch(e => { }),
                this.chrome.Debugger.enable() as any,
                this.chrome.Runtime.enable(),
                this.chrome.Log.enable()
                    .catch(e => { }),
                this.chrome.Page.enable(),
                this.chrome.Network.enable({}),
            ];
        }
    }

    private getWebViewLaunchUrl(args: ILaunchRequestArgs) {
        let launchUrl: string;
        if (args.file) {
            launchUrl = coreUtils.pathToFileURL(args.file);
        } else if (args.url) {
            launchUrl = args.url;
        }

        return launchUrl || args.urlFilter;
    }

    private getWebViewPort(args: ILaunchRequestArgs, connectionInfo: IWebViewConnectionInfo) {
        let port = 0;
        if (args.port === 0 && connectionInfo.devtoolsActivePort) {
            const lines = connectionInfo.devtoolsActivePort.split('\n');
            if (lines.length > 0) {
                const filePort = parseInt(lines[0], 10);
                port = isNaN(filePort) ? args.port : filePort;
            }
        } else {
            port = args.port;
        }

        return port || 2015;
    }

    private isMatchingWebViewTarget(connectionInfo: IWebViewConnectionInfo, targetUrl: string) {
        const webViewTarget = [{url: connectionInfo.url} as chromeConnection.ITarget];
        const targets = chromeUtils.getMatchingTargets(webViewTarget, targetUrl);
        return (targets && targets.length > 0);
    }

    // Watches for new webviews and gets a notification pipe to each so that it can later
    private async createWebViewServer(args: ILaunchRequestArgs, webViewCreatedCallback: (port: number) => void) {
        // Create the named pipe used to subscribe to new webview creation events
        const exeName = args.runtimeExecutable.split(/\\|\//).pop();
        const pipeName = `VSCode_${crypto.randomBytes(12).toString('base64')}`;
        const serverName = `\\\\.\\pipe\\WebView2\\Debugger\\${exeName}\\${pipeName}`;
        const targetUrl = this.getWebViewLaunchUrl(args);
        this._targetUrl = targetUrl;
        let isAttached = false;

        // // Clean up any previous parent pipe
        // await new Promise((resolve) => {
        //     if (this._webviewPipeServer) {
        //         this._webviewPipeServer.close(() => {
        //             resolve();
        //         });
        //     } else {
        //         resolve();
        //     }
        // });

        //this._webviewPipeServer = net.createServer((stream) => {
        this._webviewPipeServerList.push(net.createServer((stream) => {
            stream.on('data', async (data) => {
                const connectionInfo: IWebViewConnectionInfo = JSON.parse(data.toString());
                const port = this.getWebViewPort(args, connectionInfo);

                const url = connectionInfo.url;

                webViewCreatedCallback(port);

                const address = args.address || '127.0.0.1';
                const webSocketUrl = `ws://${address}:${port}/devtools/${connectionInfo.type}/${connectionInfo.id}`

                const webViewConnection = new chromeConnection.ChromeConnection();
                await webViewConnection.attachToWebsocketUrl(webSocketUrl);

                webViewConnection.api.Page.on('frameNavigated', event => this._onFrameNavigated(event));
                webViewConnection.api.Page.enable(); // if you don't enable you won't get the frameNavigated events

                await webViewConnection.api.Runtime.runIfWaitingForDebugger();
            });
        }));

        //this._webviewPipeServer.on('close', () => {
        // this._webviewPipeServerList[this._webviewPipeServerList.length].on('close', () => {
        //     //this._webviewPipeServer = undefined;
        //     webViewCreatedCallback(0);
        //     isAttached = true;
        // });

        //this._webviewPipeServer.listen(serverName);
        this._webviewPipeServerList[this._webviewPipeServerList.length].listen(serverName);

        return pipeName;
    }


    private async _onFrameNavigated(framePayload) {
        console.debug('_onFrameNavigated');
        var x = framePayload;

        const frame = framePayload.frame;

        if (frame != undefined)
        {
            const url = frame.url;
            console.debug("_onFrameNavigated: " + url)


            const webViewTarget = [{url: frame.url} as chromeConnection.ITarget];
            console.debug("checking for matching target: " + webViewTarget + " <=> " + this._targetUrl);

            const targets = chromeUtils.getMatchingTargets(webViewTarget, this._targetUrl);
            if (targets && targets.length > 0)
            {
                console.debug("found web target matching filter");

                // How do we finish the connection?
            }
            else
            {
                console.debug("Non match web target ");

            }

        }
        else
        {
            console.debug("framePlayload.Frame undefined");
        }

    }

}
