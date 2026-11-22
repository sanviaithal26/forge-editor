
import fs from 'node:fs/promises';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { registerStagingTools } from './staging.mjs';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';

const PORT = 8765;

const ROOT = realpathSync(
    process.env.FORGE_WORKSPACE_ROOT ??
    path.join(process.env.HOME, 'projects/forge-tests/flask')
);

const IGNORED = new Set([
    '.git', '.venv', 'node_modules',
    '__pycache__', '.pytest_cache', 'dist', 'build'
]);

function insideRoot(absolute) {
    const relative = path.relative(ROOT, absolute);
    return relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative);
}

async function safePath(relative = '.') {
    const requested = path.resolve(ROOT, relative);
    if (!insideRoot(requested)) {
        throw new Error('Path outside workspace');
    }

    const resolved = await fs.realpath(requested);
    if (!insideRoot(resolved)) {
        throw new Error('Symlink escapes workspace');
    }
    return resolved;
}

async function listFiles(start = '.', limit = 300) {
    const root = await safePath(start);
    const results = [];

    async function walk(directory) {
        if (results.length >= limit) return;

        const entries = await fs.readdir(directory, {
            withFileTypes: true
        });

        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            if (results.length >= limit) break;
            if (IGNORED.has(entry.name) || entry.isSymbolicLink()) {
                continue;
            }

            const full = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.isFile()) {
                results.push(
                    path.relative(ROOT, full).split(path.sep).join('/')
                );
            }
        }
    }

    const stat = await fs.stat(root);

    if (stat.isFile()) {
        return [path.relative(ROOT, root)];
    }

    await walk(root);
    return results;
}

function result(text) {
    return {
        content: [{ type: 'text', text }]
    };
}


function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


function createWorkspaceServer() {
    const server = new McpServer({
        name: 'forge-workspace',
        version: '0.1.0'
    });
    registerStagingTools(server, ROOT, safePath);
    server.registerTool(
        'list_files',
        {
            description: 'List files in the coding workspace. Read-only.',
            inputSchema: z.object({
                directory: z.string().default('.')
            }),
            annotations: { readOnlyHint: true }
        },
        async ({ directory }) => {
            try {
                const files = await listFiles(directory);
                return result(files.join('\n') || 'No files found');
            } catch (err) {
                return {
                    ...result(String(err)),
                    isError: true
                };
            }
        }
    );

    server.registerTool(
        'read_file',
        {
            description: 'Read a workspace file with line numbers.',
            inputSchema: z.object({
                file: z.string(),
                start_line: z.number().int().min(1).default(1),
                max_chars: z.number().int().min(1000).max(12000).default(8000),
                max_lines: z.number().int().min(1).max(200).default(100)
            }),
            annotations: { readOnlyHint: true }
        },
        async ({ file, start_line, max_lines, max_chars }) => {
            try {
                const full = await safePath(file);
                const stat = await fs.stat(full);

                if (!stat.isFile() || stat.size > 2_000_000) {
                    throw new Error('Not a readable source file');
                }

                const content = await fs.readFile(full, 'utf8');
                const lines = content.split('\n');

                const selected = [];
                let usedChars = 0;

                for (
                    let i = start_line - 1;
                    i < Math.min(lines.length, start_line - 1 + max_lines);
                    i++
                ) {
                    const entry = `${i + 1}: ${lines[i]}`;

                    if (usedChars + entry.length + 1 > max_chars) {
                        selected.push('[Context budget reached. Use a narrower line range.]');
                        break;
                    }

                    selected.push(entry);
                    usedChars += entry.length + 1;
                }

                return result(selected.join('\n'));

                return result(selected.join('\n'));
            } catch (err) {
                return {
                    ...result(String(err)),
                    isError: true
                };
            }
        }
    );

    server.registerTool(
        'search_code',
        {
            description: 'Search repository text for a literal string.',
            inputSchema: z.object({
                query: z.string().min(1).max(200),
                max_chars: z.number().int().min(1000).max(12000).default(6000),
                max_results: z.number().int().min(1).max(30).default(15)
            }),
            annotations: { readOnlyHint: true }
        },
        async ({ query, max_results, max_chars }) => {
            try {
                const files = await listFiles('.', 3000);
                const matches = [];
let usedChars = 0;

for (const file of files) {
    if (matches.length >= max_results) break;

    if (!/\.(py|ts|tsx|js|json|md|toml|yaml|yml)$/.test(file)) {
        continue;
    }

    const full = await safePath(file);
    const stat = await fs.stat(full);

    if (stat.size > 200_000) continue;

    const content = await fs.readFile(full, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(query.toLowerCase())) {
            continue;
        }

        const entry =
            `${file}:${i + 1}: ${lines[i].trim().slice(0, 220)}`;

        if (usedChars + entry.length + 1 > max_chars) {
            return result(
                matches.join('\n') +
                '\nContext budget reached. Refine the search query.'
            );
        }

        matches.push(entry);
        usedChars += entry.length + 1;

        if (matches.length >= max_results) break;
    }
}

        return result(matches.join('\n') || 'No matches found');
              
            } catch (err) {
                return {
                    ...result(String(err)),
                    isError: true
                };
            }
        }
    );

    server.registerTool(
        'search_symbols',
        {
            description:
                'Find definitions of a function, class, method, ' +
                'interface, type, or variable by exact symbol name. ' +
                'Returns file paths, line numbers and bounded source context.',
            inputSchema: z.object({
                symbol: z.string().min(1).max(150),
                max_results: z.number().int().min(1).max(20).default(10),
                max_chars: z.number().int().min(1000).max(20000).default(12000)
            }),
            annotations: { readOnlyHint: true }
        },
        async ({ symbol, max_results, max_chars }) => {
            try {
                // Support references such as ClassName.methodName.
                const name = symbol.split('.').pop();
                const escaped = escapeRegex(name);

                const patterns = [
                    new RegExp(
                        '^\\s*(?:async\\s+)?def\\s+' + escaped + '\\b'
                    ),
                    new RegExp(
                        '^\\s*class\\s+' + escaped + '\\b'
                    ),
                    new RegExp(
                        '^\\s*(?:export\\s+)?(?:default\\s+)?' +
                        '(?:async\\s+)?(?:function|class|interface|type|enum)\\s+' +
                        escaped + '\\b'
                    ),
                    new RegExp(
                        '^\\s*(?:export\\s+)?(?:const|let|var)\\s+' +
                        escaped + '\\s*='
                    ),
                    new RegExp(
                        '^\\s*' + escaped + '\\s*\\([^)]*\\)\\s*\\{'
                    )
                ];

                const files = await listFiles('.', 3000);
                

                const matches = [];
                let usedChars = 0;

                for (const file of files) {
                    if (matches.length >= max_results) break;
                    const supported = /\.(py|ts|tsx|js|jsx|mjs|cjs)$/.test(file);
                    if (!supported) continue;

                    const full = await safePath(file);
                    const stat = await fs.stat(full);

                    if (stat.size > 200_000) continue;

                    const content = await fs.readFile(full, 'utf8');
                    const lines = content.split('\n');

                    for (let i = 0; i < lines.length; i++) {
                        if (!patterns.some(pattern => pattern.test(lines[i]))) {
                            continue;
                        }

                        const start = Math.max(0, i - 8);
                        const end = Math.min(lines.length, i + 13);

                        const snippet = lines
                            .slice(start, end)
                            .map((line, index) =>
                                `${start + index + 1}: ${line}`
                            )
                            .join('\n');

                        const entry =
                            `${file}:${i + 1}\n${snippet}\n\n`;

                        if (usedChars + entry.length > max_chars) {
                            return result(
                                matches.join('') +
                                '\nContext budget reached. ' +
                                'Use read_file with a narrower line range.'
                            );
                        }

                        matches.push(entry);
                        usedChars += entry.length;

                        if (matches.length >= max_results) break;
                    }
                }

                return result(
                    matches.join('') ||
                    `No definitions found for symbol: ${symbol}`
                );
            } catch (err) {
                return {
                    ...result(String(err)),
                    isError: true
                };
            }
        }
    );

    return server;
}

const handler = createMcpHandler(createWorkspaceServer);
const app = createMcpExpressApp();
const nodeHandler = toNodeHandler(handler);

app.all('/mcp', (req, res) => {
    void nodeHandler(req, res, req.body);
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`Forge Workspace MCP: http://127.0.0.1:${PORT}/mcp`);
    console.log(`Workspace: ${ROOT}`);
});
