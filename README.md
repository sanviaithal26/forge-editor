# Forge Editor

**A repository-aware AI coding assistant for Visual Studio Code, powered by TrueForge.**

Forge Editor connects a VS Code extension to the TrueForge agent runtime. It enables an AI agent to inspect a repository, locate relevant code, propose coordinated multi-file edits, and present changes for developer review before modifying source files.

**Repository:** https://github.com/sanviaithal26/forge-editor

## Features

### Repository-aware agent
- TrueForge SDK integration for agent sessions, turns, and streaming events.
- MCP tools for repository listing, file reading, literal code search, symbol search, and staged edit proposals.
- Agent-driven discovery of relevant files for multi-file changes.

### Context retrieval
- `@file:path/to/file` retrieves explicitly referenced files.
- `@symbol:symbolName` searches for function, class, method, interface, type, and variable definitions.
- Search results include file paths and line numbers.
- Per-call character limits constrain file reading, code search, and symbol search.
- The agent is instructed to prioritize explicit references and avoid redundant retrieval.

### Safe editing and review
- Inline editing through a VS Code command and keyboard shortcut: `Ctrl+Shift+Alt+E`.
- Staged edit proposals rather than direct source-file writes by the agent.
- Diff previews inside VS Code.
- Hunk-level accept/reject workflow.
- Multi-file Apply All and Undo Batch.
- Original-content hash checks to detect changes made after a proposal was created.
- Undo support for applied changes.

### Streaming and cancellation
- Agent responses stream into the editor.
- A Stop action cancels the active TrueForge session.
- Cancellation was tested; the workspace remained unchanged in the tested scenario.

## Architecture

```text
VS Code Extension (TypeScript)
          |
          | TrueForge TypeScript SDK
          v
TrueForge Local Runtime
          |
          | Agent sessions and turns
          v
Coding Agent
          |
          | MCP tool calls
          v
Workspace MCP Server
          |
          +-- list_files
          +-- read_file
          +-- search_code
          +-- search_symbols
          +-- propose_edit
          |
          v
Local Staging Store
          |
          v
VS Code Diff Review
          |
          v
Developer accepts / rejects
```

The agent instructions are defined by the `AGENT_INSTRUCTIONS` constant in `src/extension.ts` and supplied to the TrueForge agent when a session is created.

The MCP server is implemented in `mcp/server.mjs`; staged edit proposals are implemented in `mcp/staging.mjs`.

## Starting point

Built from a standard VS Code TypeScript extension scaffold. This project is not a fork of Cline, Continue, Roo Code, or another coding-agent product. The agent loop is implemented using the TrueForge SDK.

## Requirements

- Visual Studio Code 1.146 or later.
- Node.js 22 or compatible supported version.
- npm.
- TrueForge local runtime.
- A model configured in TrueForge.
- A configured MCP workspace endpoint.

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/sanviaithal26/forge-editor.git
cd forge-editor
npm install
```

### 2. Prepare the test workspace

The current MCP server is configured to work with a fixed Flask test workspace.

```bash
git clone https://github.com/pallets/flask.git ~/projects/forge-tests/flask
cd ~/projects/forge-tests/flask
git checkout 3.1.3
```

### 3. Start the MCP workspace server

Open a separate terminal:

```bash
cd ~/projects/forge-editor

FORGE_WORKSPACE_ROOT="$HOME/projects/forge-tests/flask" \
node mcp/server.mjs
```

The MCP endpoint is:

```text
http://127.0.0.1:8765/mcp
```

Configure the local TrueForge runtime to use this workspace MCP server.

### 4. Start TrueForge

In another terminal:

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' \
npx @truefoundry/trueforge@latest
```

The local dashboard is available at:

```text
http://localhost:8790
```

Configure a supported model in the TrueForge runtime before starting an agent session.

### 5. Configure the model

The tested model identifier is:

```text
google-gemini/gemini-3-1-flash-lite
```

The model is configured through TrueForge. The current extension also specifies the model identifier in the `MODEL` constant in `src/extension.ts`. To use a different model, configure it in TrueForge and update that identifier to match.

Do not commit API keys or credentials. Configure provider credentials through the appropriate TrueForge configuration mechanism.

### 6. Launch the extension

From the Forge Editor repository:

```bash
npm run compile
```

Open the project in VS Code and press `F5` to launch the Extension Development Host.

Use the Command Palette to run:

- `Forge Editor: Open Agent`
- `Forge Editor: Review Staged Changes`
- `Forge Editor: Edit Selection`

The inline-edit shortcut is `Ctrl+Shift+Alt+E` when an editor selection is active.

## Testing

The following checks were reported during development:

| Test | Result |
|---|---|
| Flask helper and CLI tests | 92 passed, 3 skipped |
| TypeScript compilation | Passed |
| VS Code extension-host test | 1 passing |
| Apply All and Undo Batch | Tested successfully |
| Inline editing | Tested successfully |
| `@file` and `@symbol` retrieval | Tested successfully |
| Context retrieval limits | Tested successfully |
| Cancellation | Tested successfully; workspace unchanged |

Lint reported zero errors and 16 style warnings.

## Known limitations

- The MCP server currently accesses a configured Flask workspace, not arbitrary folders opened in VS Code.
- The model identifier is currently specified in the extension source; model switching is not exposed as an extension setting.
- Context limits apply per tool call, not through a strict cumulative counter across an entire user request.
- Symbol retrieval uses declaration-pattern matching rather than a full AST or language-server index.
- The agent currently has no MCP terminal-command execution tool.
- Automatic fallback to a second model has not been implemented or verified.
- The current implementation has been tested with the configured Gemini model through TrueForge, not with every supported provider.

## Development tools

- TypeScript and Visual Studio Code Extension API
- TrueForge TypeScript SDK
- Model Context Protocol (MCP)
- Node.js, Express, and Zod
- Gemini through the TrueForge runtime
- ChatGPT and Gemini as development assistants

## License

Add the chosen open-source license in the root `LICENSE` file before distribution.
