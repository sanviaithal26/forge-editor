
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

const BASE_URL = 'http://localhost:8790';

// Matches the model listed in your TrueForge screenshot.
// Change this only if the model identifier in TrueForge differs.
const MODEL = 'google-gemini/gemini-3-1-flash-lite';


const AGENT_INSTRUCTIONS = `
You are Forge Editor, a repository-aware coding assistant.

You have read-only tools for inspecting the current
configured repository:

- list_files: discover repository files
- search_code: find relevant code and symbols
- read_file: inspect source code with line numbers

When the user asks about repository code:
1. Search for relevant files and symbols.
2. Read actual source code before answering.
3. Identify the file paths and relevant line numbers.
4. Explain why the selected files are relevant.
5. Never invent source code or claim that you inspected
   files unless you actually used the tools.

You cannot currently modify files or run tests.
Do not claim otherwise.

The available tools currently access a fixed Flask
test workspace, not arbitrary open VS Code folders.
`;


export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand(
        'forge-editor.openAgent',
        () => openAgentPanel()
    );

    context.subscriptions.push(disposable);
}

async function openAgentPanel() {
	
    const { TrueForge } = await import(
        '@truefoundry/trueforge-sdk'
    );

    const panel = vscode.window.createWebviewPanel(
        'forgeAgent',
        'Forge Editor',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    const client = new TrueForge({
        baseUrl: BASE_URL,
        timeoutInSeconds: 600
    });

    let sessionId: string | undefined;
    let busy = false;
    let cancelRequested = false;
    let disposed = false;

    panel.onDidDispose(() => {
        disposed = true;
        if (busy && sessionId) {
            void client.sessions.cancel(sessionId).catch(
                err => console.error('Cancel failed:', err)
            );
        }
    });

    const send = (message: object) => {
        if (!disposed) {
            void panel.webview.postMessage(message);
        }
    };

    async function ensureSession(): Promise<string> {
        if (sessionId) {
            return sessionId;
        }


        const result = await client.sessions.create({
            agent: {
                spec: {
                    model: { name: MODEL },
                    instructions: AGENT_INSTRUCTIONS,
                    mcpServers: [
                        {
                            name: 'forge-workspace',
                            enableTools: [
                                'list_files',
                                'read_file',
                                'search_code'
                            ],
                            preload: true
                        }
                    ]
                }
            },
            metadata: {
                'tfg.source': 'ui',
                'is_create_agent': 'false'
            }
        });


        sessionId = result.data.id;
        send({ type: 'session', id: sessionId });
        return sessionId;
    }

    async function runPrompt(text: string) {
        if (busy || !text.trim()) {
            return;
        }

        busy = true;
        cancelRequested = false;
        send({ type: 'busy', value: true });
        send({ type: 'start', prompt: text });

        let responseText = '';

        try {
            const id = await ensureSession();

            if (cancelRequested || disposed) {
                send({ type: 'status', text: 'Cancelled' });
                return;
            }

            send({
                type: 'status',
                text: 'Generating through TrueForge...'
            });

            const stream = await client.sessions.createTurnStream(
                id,
                {
                    input: [
                        {
                            type: 'user.message',
                            content: text
                        }
                    ]
                }
            );

            if (cancelRequested) {
                await client.sessions.cancel(id);
            }

            for await (const event of stream) {
                if (event.type === 'model.message.delta') {
                    if (
                        !event.threadId ||
                        event.threadId === 'main'
                    ) {
                        const chunk = event.content ?? '';
                        responseText += chunk;
                        send({ type: 'delta', text: chunk });
                    }
                }

                if (event.type === 'turn.done') {
                    const status = event.state.status;

					if (
						status === 'done' &&
						!responseText &&
						event.state.output?.content
					) {
						const content = event.state.output.content;

						responseText =
							typeof content === 'string'
								? content
								: Array.isArray(content)
									? content
										.map(item => {
											if (typeof item === 'string') {
												return item;
											}

											if (
												item &&
												typeof item === 'object' &&
												'text' in item &&
												typeof item.text === 'string'
											) {
												return item.text;
											}

											return '';
										})
										.filter(Boolean)
										.join('\n')
									: '';

						if (responseText) {
							send({
								type: 'delta',
								text: responseText
							});
						}
					}
				}

                if (
                    event.type === 'turn.update' &&
                    event.state.status === 'paused'
                ) {
                    send({
                        type: 'status',
                        text: 'Turn paused: requires interaction'
                    });
                }
            }
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : String(error);

            send({
                type: 'error',
                text: message
            });
        } finally {
            busy = false;
            cancelRequested = false;
            send({ type: 'busy', value: false });
        }
    }

    panel.webview.onDidReceiveMessage(async message => {
        if (message.type === 'prompt') {
            if (typeof message.text === 'string') {
                await runPrompt(message.text);
            }
        }

        if (message.type === 'cancel' && busy) {
            cancelRequested = true;
            send({ type: 'status', text: 'Cancelling...' });

            if (sessionId) {
                try {
                    await client.sessions.cancel(sessionId);
                } catch (error) {
                    send({
                        type: 'error',
                        text: String(error)
                    });
                }
            }
        }

        if (message.type === 'newSession' && !busy) {
            sessionId = undefined;
            send({ type: 'reset' });
        }
    });

    panel.webview.html = getWebviewContent();
}

function getWebviewContent(): string {
    const nonce = randomBytes(16).toString('base64');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport"
      content="width=device-width, initial-scale=1.0">

<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               style-src 'unsafe-inline';
               script-src 'nonce-${nonce}';">

<style>
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 16px;
    }

    header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 20px;
    }

    h2 { margin: 0; }

    .message {
        padding: 12px;
        margin: 12px 0;
        border-radius: 8px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }

    .user {
        background: var(--vscode-input-background);
    }

    .assistant {
        border: 1px solid var(--vscode-panel-border);
    }

    .role {
        font-size: 11px;
        font-weight: bold;
        opacity: 0.7;
        margin-bottom: 8px;
    }

    textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 10px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border);
        resize: vertical;
    }

    button {
        padding: 8px 14px;
        border: 0;
        border-radius: 4px;
        cursor: pointer;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
    }

    button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .controls {
        display: flex;
        gap: 8px;
        margin-top: 10px;
    }

    #status {
        font-size: 12px;
        opacity: 0.8;
        margin: 12px 0;
    }

    #session {
        font-size: 10px;
        opacity: 0.55;
        overflow-wrap: anywhere;
    }

    .error {
        color: var(--vscode-errorForeground);
    }
</style>
</head>
<body>
    <header>
        <h2>Forge Editor</h2>
        <button id="newChat">New Chat</button>
    </header>

    <div id="messages" role="log" aria-live="polite"></div>

    <div id="status" role="status">Ready</div>
    <div id="session"></div>

    <textarea id="prompt" rows="4"
        placeholder="Ask Forge Editor anything about code..."></textarea>

    <div class="controls">
        <button id="send">Send</button>
        <button id="stop" disabled>Stop</button>
    </div>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const messages = document.getElementById('messages');
    const promptInput = document.getElementById('prompt');
    const sendButton = document.getElementById('send');
    const stopButton = document.getElementById('stop');
    const newChatButton = document.getElementById('newChat');
    const status = document.getElementById('status');

    let currentReply = null;

    function addMessage(role, text) {
        const wrapper = document.createElement('div');
        wrapper.className =
            'message ' + (role === 'You' ? 'user' : 'assistant');

        const heading = document.createElement('div');
        heading.className = 'role';
        heading.textContent = role;

        const content = document.createElement('div');
        content.textContent = text;

        wrapper.appendChild(heading);
        wrapper.appendChild(content);
        messages.appendChild(wrapper);

        return content;
    }

    function submit() {
        const text = promptInput.value.trim();
        if (!text || sendButton.disabled) return;

        promptInput.value = '';
        vscode.postMessage({ type: 'prompt', text });
    }

    sendButton.addEventListener('click', submit);

    promptInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
        }
    });

    stopButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'cancel' });
    });

    newChatButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'newSession' });
    });

    window.addEventListener('message', event => {
        const message = event.data;

        switch (message.type) {
            case 'start':
                addMessage('You', message.prompt);
                currentReply = addMessage('Forge Agent', '');
                break;

            case 'delta':
                if (currentReply) {
                    currentReply.textContent += message.text;
                }
                break;

            case 'status':
                status.textContent = message.text;
                break;

            case 'session':
                document.getElementById('session').textContent =
                    'Session: ' + message.id;
                break;

            case 'busy':
                sendButton.disabled = message.value;
                stopButton.disabled = !message.value;
                newChatButton.disabled = message.value;
                break;

            case 'error':
                status.textContent = 'Error: ' + message.text;
                status.className = 'error';
                break;

            case 'reset':
                messages.replaceChildren();
                currentReply = null;
                document.getElementById('session').textContent = '';
                status.textContent = 'New conversation ready';
                status.className = '';
                break;
        }

        messages.lastElementChild?.scrollIntoView({
            behavior: 'smooth',
            block: 'end'
        });
    });
</script>
</body>
</html>`;
}

export function deactivate() {}
