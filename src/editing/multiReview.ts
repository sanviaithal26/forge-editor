
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { structuredPatch, applyPatch } from 'diff';

type Proposal = {
    id: string;
    workspaceRoot: string;
    file: string;
    originalHash: string;
    original: string;
    proposed: string;
    explanation: string;
    createdAt: string;
};

type FileChange = {
    proposal: Proposal;
    uri: vscode.Uri;
    document: vscode.TextDocument;
    before: string;
    after: string;
};

type BatchRecord = {
    id: string;
    status: 'prepared' | 'applied';
    files: {
        path: string;
        before: string;
        afterHash: string;
    }[];
};

const STAGING = path.join(
    os.homedir(), '.cache', 'forge-editor', 'staging'
);

const hash = (s: string) =>
    crypto.createHash('sha256').update(s).digest('hex');

let busy = false;

async function loadProposals(): Promise<Proposal[]> {
    const entries = await fs.readdir(STAGING)
        .catch(() => [] as string[]);

    const result: Proposal[] = [];

    for (const name of entries) {
        if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;

        try {
            const p = JSON.parse(
                await fs.readFile(path.join(STAGING, name), 'utf8')
            ) as Proposal;

            if (
                p.id === name.slice(0, -5) &&
                typeof p.file === 'string' &&
                typeof p.workspaceRoot === 'string' &&
                typeof p.original === 'string' &&
                typeof p.proposed === 'string' &&
                typeof p.originalHash === 'string' &&
                hash(p.original) === p.originalHash
            ) {
                result.push(p);
            }
        } catch {
            // Ignore invalid staging records.
        }
    }

    return result.sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt)
    );
}

function inside(root: string, target: string): boolean {
    const rel = path.relative(root, target);

    return rel === '' || (
        rel !== '..' &&
        !rel.startsWith('..' + path.sep) &&
        !path.isAbsolute(rel)
    );
}

async function checkFile(p: Proposal) {
    const root = await fs.realpath(p.workspaceRoot);
    const target = await fs.realpath(path.resolve(root, p.file));

    if (target === root || !inside(root, target)) {
        throw new Error(`Unsafe path: ${p.file}`);
    }

    const workspaceRoots = await Promise.all(
        (vscode.workspace.workspaceFolders ?? []).map(
            f => fs.realpath(f.uri.fsPath)
        )
    );

    if (!workspaceRoots.includes(root)) {
        throw new Error(`Open the correct workspace: ${root}`);
    }

    const uri = vscode.Uri.file(target);
    const document = await vscode.workspace.openTextDocument(uri);
    const disk = await fs.readFile(target, 'utf8');

    if (
        document.isDirty ||
        document.getText() !== disk ||
        hash(disk) !== p.originalHash
    ) {
        throw new Error(`Stale or unsaved file: ${p.file}`);
    }

    return { uri, document, disk };
}

function fullRange(doc: vscode.TextDocument): vscode.Range {
    return new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length)
    );
}

function batchDirectory(context: vscode.ExtensionContext) {
    return path.join(context.globalStorageUri.fsPath, 'batches');
}

async function existingBatch(context: vscode.ExtensionContext) {
    const dir = batchDirectory(context);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    return names.filter(n => n.endsWith('.json'));
}

export function registerMultiReview(
    context: vscode.ExtensionContext
): void {

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'forge-editor.applyAll',
            async () => {
                if (busy) return;
                busy = true;

                try {
                    if ((await existingBatch(context)).length) {
                        throw new Error(
                            'A batch undo/recovery record exists. ' +
                            'Undo or resolve it before applying another batch.'
                        );
                    }

                    const proposals = await loadProposals();

                    if (!proposals.length) {
                        vscode.window.showInformationMessage(
                            'No staged edits available.'
                        );
                        return;
                    }

                    // A proposal is currently a full-file snapshot.
                    // Applying two such proposals to one file is unsafe.
                    const paths = proposals.map(p =>
                        path.resolve(p.workspaceRoot, p.file)
                    );

                    if (new Set(paths).size !== paths.length) {
                        throw new Error(
                            'Multiple proposals target the same file. ' +
                            'Reject the stale proposals and regenerate ' +
                            'one combined proposal per file.'
                        );
                    }

                    const changes: FileChange[] = [];
                    const choices: {
                        label: string;
                        description: string;
                        detail: string;
                        fileIndex: number;
                        hunkIndex: number;
                        picked: boolean;
                    }[] = [];

                    const patches: ReturnType<typeof structuredPatch>[] = [];

                    for (const p of proposals) {
                        const checked = await checkFile(p);

                        const patch = structuredPatch(
                            p.file, p.file,
                            p.original, p.proposed,
                            '', '', { context: 0 }
                        );

                        const index = changes.length;

                        changes.push({
                            proposal: p,
                            uri: checked.uri,
                            document: checked.document,
                            before: checked.disk,
                            after: checked.disk
                        });

                        patches.push(patch);

                        patch.hunks.forEach((h, j) => {
                            choices.push({
                                label: `${p.file} — Hunk ${j + 1}`,
                                description: `Line ${h.oldStart}`,
                                detail: h.lines.slice(0, 6)
                                    .join(' | ').slice(0, 300),
                                fileIndex: index,
                                hunkIndex: j,
                                picked: true
                            });
                        });
                    }

                    if (!choices.length) {
                        vscode.window.showInformationMessage(
                            'No staged differences found.'
                        );
                        return;
                    }

                    const selected = await vscode.window.showQuickPick(
                        choices,
                        {
                            canPickMany: true,
                            placeHolder:
                                'Select the hunks to apply across files'
                        }
                    );

                    if (!selected?.length) return;

                    const selectedKeys = new Set(
                        selected.map(x => `${x.fileIndex}:${x.hunkIndex}`)
                    );

                    const accepted: FileChange[] = [];

                    changes.forEach((change, i) => {
                        const patch = patches[i];

                        const selectedHunks = patch.hunks.filter(
                            (_, j) => selectedKeys.has(`${i}:${j}`)
                        );

                        if (!selectedHunks.length) return;

                        const result = applyPatch(
                            change.before,
                            { ...patch, hunks: selectedHunks },
                            { fuzzFactor: 0 }
                        );

                        if (result === false) {
                            throw new Error(
                                `Patch failed for ${change.proposal.file}`
                            );
                        }

                        change.after = result;
                        accepted.push(change);
                    });

                    const confirmation =
                        await vscode.window.showWarningMessage(
                            `Apply ${selected.length} hunks across ` +
                            `${accepted.length} files?`,
                            { modal: true },
                            'Apply Batch'
                        );

                    if (confirmation !== 'Apply Batch') return;

                    // Recheck every file immediately before changing any.
                    for (const change of accepted) {
                        await checkFile(change.proposal);
                    }

                    const record: BatchRecord = {
                        id: crypto.randomUUID(),
                        status: 'prepared',
                        files: accepted.map(c => ({
                            path: c.uri.fsPath,
                            before: c.before,
                            afterHash: hash(c.after)
                        }))
                    };

                    const dir = batchDirectory(context);
                    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

                    const recordFile = path.join(
                        dir, `${record.id}.json`
                    );

                    // Keep recovery snapshots before applying.
                    await fs.writeFile(
                        recordFile,
                        JSON.stringify(record),
                        { flag: 'wx', mode: 0o600 }
                    );

                    const edit = new vscode.WorkspaceEdit();

                    for (const change of accepted) {
                        edit.replace(
                            change.uri,
                            fullRange(change.document),
                            change.after
                        );
                    }

                    if (!await vscode.workspace.applyEdit(edit)) {
                        await fs.unlink(recordFile);
                        throw new Error('Batch edit was rejected.');
                    }

                    // Saves are sequential: on failure keep the recovery
                    // record and report the problem, never hide it.
                    for (const change of accepted) {
                        const saved = await change.document.save();
                        if (!saved) {
                            throw new Error(
                                `Failed to save ${change.proposal.file}. ` +
                                'Recovery record retained.'
                            );
                        }

                        const disk = await fs.readFile(
                            change.uri.fsPath, 'utf8'
                        );

                        if (disk !== change.after) {
                            throw new Error(
                                `Saved content mismatch: ` +
                                change.proposal.file
                            );
                        }
                    }

                    record.status = 'applied';
                    await fs.writeFile(
                        recordFile, JSON.stringify(record)
                    );

                    // Remove every proposal only after verified saves.
                    for (const change of changes) {
                        await fs.unlink(
                            path.join(
                                STAGING,
                                `${change.proposal.id}.json`
                            )
                        );
                    }

                    vscode.window.showInformationMessage(
                        `Applied ${selected.length} hunks across ` +
                        `${accepted.length} files.`
                    );
                } catch (error) {
                    vscode.window.showErrorMessage(String(error));
                } finally {
                    busy = false;
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'forge-editor.undoBatch',
            async () => {
                if (busy) return;
                busy = true;

                try {
                    const dir = batchDirectory(context);
                    const names = await existingBatch(context);

                    if (!names.length) {
                        vscode.window.showInformationMessage(
                            'No batch changes to undo.'
                        );
                        return;
                    }

                    if (names.length !== 1) {
                        throw new Error(
                            'Multiple recovery records found. ' +
                            'Manual inspection required.'
                        );
                    }

                    const recordPath = path.join(dir, names[0]);
                    const record = JSON.parse(
                        await fs.readFile(recordPath, 'utf8')
                    ) as BatchRecord;

                    if (record.status !== 'applied') {
                        throw new Error(
                            'Incomplete application detected. ' +
                            'Inspect files and recovery record before undo.'
                        );
                    }

                    const folders = await Promise.all(
                        (vscode.workspace.workspaceFolders ?? [])
                            .map(f => fs.realpath(f.uri.fsPath))
                    );

                    const documents = [];

                    for (const item of record.files) {
                        const target = await fs.realpath(item.path);

                        if (!folders.some(root => inside(root, target))) {
                            throw new Error(
                                'Affected file is outside open workspace.'
                            );
                        }

                        const doc =
                            await vscode.workspace.openTextDocument(
                                vscode.Uri.file(target)
                            );

                        const current = await fs.readFile(target, 'utf8');

                        if (
                            doc.isDirty ||
                            doc.getText() !== current ||
                            hash(current) !== item.afterHash
                        ) {
                            throw new Error(
                                `File changed after application: ${target}`
                            );
                        }

                        documents.push({ doc, item });
                    }

                    const answer =
                        await vscode.window.showWarningMessage(
                            `Undo changes across ${documents.length} files?`,
                            { modal: true },
                            'Undo Batch'
                        );

                    if (answer !== 'Undo Batch') return;

                    const edit = new vscode.WorkspaceEdit();

                    for (const { doc, item } of documents) {
                        edit.replace(
                            doc.uri,
                            fullRange(doc),
                            item.before
                        );
                    }

                    if (!await vscode.workspace.applyEdit(edit)) {
                        throw new Error('Undo batch failed.');
                    }

                    for (const { doc, item } of documents) {
                        if (!await doc.save()) {
                            throw new Error(
                                'Undo could not save all files. ' +
                                'Recovery record retained.'
                            );
                        }

                        if (
                            await fs.readFile(doc.uri.fsPath, 'utf8') !==
                            item.before
                        ) {
                            throw new Error(
                                'Undo verification failed.'
                            );
                        }
                    }

                    await fs.unlink(recordPath);

                    vscode.window.showInformationMessage(
                        'Multi-file change successfully undone.'
                    );
                } catch (error) {
                    vscode.window.showErrorMessage(String(error));
                } finally {
                    busy = false;
                }
            }
        )
    );
}
