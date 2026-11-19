
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand(
        'forge-editor.openAgent',
        () => {
            const panel = vscode.window.createWebviewPanel(
                'forgeAgent',
                'Forge Editor',
                vscode.ViewColumn.Beside,
                { enableScripts: true }
            );

            panel.webview.html = getWebviewContent();

            panel.webview.onDidReceiveMessage(
                async (message) => {
                    if (message.type === 'prompt') {
                        panel.webview.postMessage({
                            type: 'response',
                            text: `Received: ${message.text}`
                        });
                    }
                },
                undefined,
                context.subscriptions
            );
        }
    );

    context.subscriptions.push(disposable);
}

function getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport"
          content="width=device-width, initial-scale=1.0">
    <title>Forge Editor</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
        }

        textarea {
            width: 100%;
            box-sizing: border-box;
            padding: 10px;
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
        }

        button {
            margin-top: 10px;
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            cursor: pointer;
        }

        #output {
            margin-top: 20px;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }
    </style>
</head>
<body>
    <h2>Forge Editor</h2>
    <p>AI coding agent powered by TrueForge</p>

    <textarea id="prompt" rows="5"
        placeholder="Ask Forge Editor to modify your code..."></textarea>

    <button id="send">Send</button>

    <div id="output" role="status"></div>

    <script>
        const vscode = acquireVsCodeApi();

        document.getElementById('send')
            .addEventListener('click', () => {
                const text = document.getElementById('prompt').value;

                vscode.postMessage({
                    type: 'prompt',
                    text: text
                });
            });

        window.addEventListener('message', event => {
            const message = event.data;

            if (message.type === 'response') {
                document.getElementById('output').textContent =
                    message.text;
            }
        });
    </script>
</body>
</html>`;
}

export function deactivate() {}
