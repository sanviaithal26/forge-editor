
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import * as z from 'zod/v4';

export const STAGING_DIR = path.join(
    os.homedir(),
    '.cache',
    'forge-editor',
    'staging'
);

function hash(text) {
    return crypto.createHash('sha256')
        .update(text, 'utf8')
        .digest('hex');
}

function toolResult(text, isError = false) {
    return {
        content: [{ type: 'text', text }],
        isError
    };
}

export function registerStagingTools(server, root, safePath) {
    server.registerTool(
        'propose_edit',
        {
            description:
                'Propose a source-code edit without modifying the file. ' +
                'Provide an exact, unique old_text snippet and its replacement. ' +
                'The proposal must be reviewed in VS Code before applying.',
            inputSchema: z.object({
                file: z.string().min(1),
                old_text: z.string().min(1).max(12000),
                new_text: z.string().max(20000),
                explanation: z.string().min(1).max(1000)
            })
        },
        async ({ file, old_text, new_text, explanation }) => {
            try {
                const fullPath = await safePath(file);
                const stat = await fs.stat(fullPath);

                if (!stat.isFile() || stat.size > 1_000_000) {
                    throw new Error('File too large or not a file');
                }

                const original = await fs.readFile(fullPath, 'utf8');

                if (original.includes('\0')) {
                    throw new Error('Binary files are not supported');
                }

                const first = original.indexOf(old_text);

                if (first === -1) {
                    throw new Error(
                        'old_text was not found exactly in the file'
                    );
                }

                if (original.indexOf(old_text, first + 1) !== -1) {
                    throw new Error(
                        'old_text occurs more than once. ' +
                        'Provide a longer unique snippet.'
                    );
                }

                const proposed =
                    original.slice(0, first) +
                    new_text +
                    original.slice(first + old_text.length);

                if (proposed === original) {
                    throw new Error('Proposed edit makes no change');
                }

                const id = crypto.randomUUID();

                const proposal = {
                    id,
                    workspaceRoot: root,
                    file: path.relative(root, fullPath)
                        .split(path.sep).join('/'),
                    originalHash: hash(original),
                    original,
                    proposed,
                    explanation,
                    createdAt: new Date().toISOString()
                };

                await fs.mkdir(STAGING_DIR, {
                    recursive: true,
                    mode: 0o700
                });

                await fs.writeFile(
                    path.join(STAGING_DIR, `${id}.json`),
                    JSON.stringify(proposal),
                    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
                );

                return toolResult(
                    `STAGED EDIT ${id}\n` +
                    `File: ${proposal.file}\n` +
                    `Reason: ${explanation}\n` +
                    'No source files were modified. ' +
                    'The user must review the proposal in VS Code.'
                );
            } catch (error) {
                return toolResult(String(error), true);
            }
        }
    );
}
