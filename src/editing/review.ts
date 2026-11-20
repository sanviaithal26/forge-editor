
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { structuredPatch, applyPatch } from 'diff';

interface Proposal {
    id: string;
    workspaceRoot: string;
    file: string;
    originalHash: string;
    original: string;
    proposed: string;
    explanation: string;
    createdAt: string;
}

interface UndoRecord {
    id: string;
    file: string;
    before: string;
    afterHash: string;
    appliedAt: string;
}

const STAGING = path.join(
    os.homedir(), '.cache', 'forge-editor', 'staging'
);

const previews = new Map<string, string>();
let applying = false;

function hash(text: string): string {
    return crypto.createHash('sha256')
        .update(text).digest('hex');
}

function inside(root: string, target: string): boolean {
    const rel = path.relative(root, target);
    return rel === '' ||
        (rel !== '..' &&
         !rel.startsWith('..' + path.sep) &&
         !path.isAbsolute(rel));
}

function undoDir(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, 'undo');
}

async function getProposals(): Promise<Proposal[]> {
    let names: string[];

    try {
        names = (await fs.readdir(STAGING))
            .filter(n => /^[0-9a-f-]{36}\.json$/i.test(n));
    } catch {
        return [];
    }

    const proposals: Proposal[] = [];

    for (const name of names) {
        try {
            const raw = await fs.readFile(
                path.join(STAGING, name), 'utf8'
            );
            const p = JSON.parse(raw) as Proposal;

            if (
                p.id === name.slice(0, -5) &&
                typeof p.workspaceRoot === 'string' &&
                typeof p.file === 'string' &&
                typeof p.original === 'string' &&
                typeof p.proposed === 'string' &&
                typeof p.explanation === 'string' &&
                typeof p.createdAt === 'string' &&
                hash(p.original) === p.originalHash
            ) {
                proposals.push(p);
            }
        } catch {
            // Skip invalid proposals.
        }
    }

    return proposals.sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt)
    );
}

async function chooseProposal(): Promise<Proposal | undefined> {
    const proposals = await getProposals();

    if (!proposals.length) {
        vscode.window.showInformationMessage(
            'No staged changes found.'
        );
        return;
    }

    const item = await vscode.window.showQuickPick(
        proposals.map(p => ({
            label: p.file,
            description: p.explanation,
            detail: p.id,
            proposal: p
        })),
        { placeHolder: 'Select a staged change' }
    );

    return item?.proposal;
}

async function getDocument(
    p: Proposal
): Promise<vscode.TextDocument> {
    const root = await fs.realpath(p.workspaceRoot);
    const absolute = await fs.realpath(
        path.resolve(root, p.file)
    );

    if (!inside(root, absolute) || root === absolute) {
        throw new Error('Path outside workspace.');
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    let allowed = false;

    for (const folder of folders) {
        const folderRoot = await fs.realpath(folder.uri.fsPath);
        if (folderRoot === root) {
            allowed = true;
        }
    }

    if (!allowed) {
        throw new Error('Open the matching workspace first.');
    }

    const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(absolute)
    );

    if (document.isDirty) {
        throw new Error('Save open file changes first.');
    }

    const disk = await fs.readFile(absolute, 'utf8');

    if (
        hash(disk) !== p.originalHash ||
        document.getText() !== disk
    ) {
        throw new Error(
            'File changed since staging. Regenerate proposal.'
        );
    }

    return document;
}

function entireRange(
    document: vscode.TextDocument
): vscode.Range {
    return new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
    );
}

async function showDiff(
    uri: vscode.Uri,
    content: string,
    id: string
) {
    const preview = vscode.Uri.from({
        scheme: 'forge-preview',
        path: '/' + id + '/' + path.basename(uri.fsPath)
    });

    previews.set(preview.path, content);

    await vscode.commands.executeCommand(
        'vscode.diff',
        uri,
        preview,
        'Forge Editor — Proposed Changes',
        { preview: false }
    );
}

async function readUndo(
    context: vscode.ExtensionContext
): Promise<UndoRecord[]> {
    const directory = undoDir(context);
    let filenames: string[];

    try {
        filenames = (await fs.readdir(directory))
            .filter(n => n.endsWith('.json'));
    } catch {
        return [];
    }

    const records: UndoRecord[] = [];

    for (const name of filenames) {
        try {
            const record = JSON.parse(
                await fs.readFile(
                    path.join(directory, name), 'utf8'
                )
            ) as UndoRecord;

            if (
                typeof record.id === 'string' &&
                typeof record.file === 'string' &&
                typeof record.before === 'string' &&
                typeof record.afterHash === 'string' &&
                typeof record.appliedAt === 'string'
            ) {
                records.push(record);
            }
        } catch {
            // Skip invalid records.
        }
    }

    return records.sort((a, b) =>
        b.appliedAt.localeCompare(a.appliedAt)
    );
}

export function registerReviewCommands(
    context: vscode.ExtensionContext
): void {

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            'forge-preview',
            {
                provideTextDocumentContent(uri) {
                    return previews.get(uri.path) ?? '';
                }
            }
        )
    );

    // REVIEW
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'forge-editor.reviewEdits',
            async () => {
                try {
                    const p = await chooseProposal();
                    if (!p) return;

                    const doc = await getDocument(p);
                    await showDiff(doc.uri, p.proposed, p.id);
                } catch (error) {
                    vscode.window.showErrorMessage(String(error));
                }
            }
        )
    );

    // APPLY SELECTED HUNKS
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'forge-editor.applyHunks',
            async () => {
                if (applying) return;
                applying = true;

                try {
                    const p = await chooseProposal();
                    if (!p) return;

                    const doc = await getDocument(p);

                    const patch = structuredPatch(
                        p.file,
                        p.file,
                        p.original,
                        p.proposed,
                        '',
                        '',
                        { context: 0 }
                    );

                    if (!patch.hunks.length) {
                        vscode.window.showInformationMessage(
                            'No differences found.'
                        );
                        return;
                    }

                    const choices = patch.hunks.map((h, i) => ({
                        label: 'Hunk ' + (i + 1),
                        description:
                            `Line ${h.oldStart}: ` +
                            `${h.oldLines} old → ${h.newLines} new`,
                        detail: h.lines
                            .slice(0, 6)
                            .join(' | ')
                            .slice(0, 300),
                        index: i,
                        picked: true
                    }));

                    const selected = await vscode.window.showQuickPick(
                        choices,
                        {
                            canPickMany: true,
                            placeHolder:
                                'Select hunks to accept'
                        }
                    );

                    if (!selected || !selected.length) return;

                    const selectedIndexes = new Set(
                        selected.map(s => s.index)
                    );

                    const selectedPatch = {
                        ...patch,
                        hunks: patch.hunks.filter(
                            (_, i) => selectedIndexes.has(i)
                        )
                    };

                    const result = applyPatch(
                        p.original,
                        selectedPatch,
                        { fuzzFactor: 0 }
                    );

                    if (result === false) {
                        throw new Error('Could not apply selected hunks.');
                    }

                    await showDiff(
                        doc.uri,
                        result,
                        p.id + '-selected'
                    );

                    const confirmation =
                        await vscode.window.showWarningMessage(
                            `Apply ${selected.length} of ` +
                            `${patch.hunks.length} hunks?`,
                            { modal: true },
                            'Apply'
                        );

                    if (confirmation !== 'Apply') return;

                    const fresh = await getDocument(p);

                    const existing = await readUndo(context);

                    if (existing.some(r => r.id === p.id)) {
                        throw new Error('Proposal already applied.');
                    }

                    const undoDirectory = undoDir(context);

                    await fs.mkdir(undoDirectory, {
                        recursive: true
                    });

                    const record: UndoRecord = {
                        id: p.id,
                        file: fresh.uri.fsPath,
                        before: p.original,
                        afterHash: hash(result),
                        appliedAt: new Date().toISOString()
                    };

                    const recordPath = path.join(
                        undoDirectory,
                        p.id + '.json'
                    );

                    // Record recovery data before editing.
                    await fs.writeFile(
                        recordPath,
                        JSON.stringify(record),
                        { flag: 'wx', mode: 0o600 }
                    );

                    const edit = new vscode.WorkspaceEdit();

                    edit.replace(
                        fresh.uri,
                        entireRange(fresh),
                        result
                    );

                    if (!await vscode.workspace.applyEdit(edit)) {
                        throw new Error('VS Code rejected the edit.');
                    }

                    if (!await fresh.save()) {
                        throw new Error(
                            'File was changed in editor but not saved.'
                        );
                    }

                    const disk = await fs.readFile(
                        fresh.uri.fsPath, 'utf8'
                    );

                    if (disk !== result) {
                        throw new Error(
                            'Saved file does not match approved text.'
                        );
                    }

                    await fs.unlink(
                        path.join(STAGING, p.id + '.json')
                    );

                    vscode.window.showInformationMessage(
                        'Selected hunks applied successfully.'
                    );
                } catch (error) {
                    vscode.window.showErrorMessage(String(error));
                } finally {
                    applying = false;
                }
            }
        )
    );

    // REJECT PROPOSAL
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'forge-editor.rejectEdit',
            async () => {
                try {
                    const p = await chooseProposal();
                    if (!p) return;

                    const answer =
                        await vscode.window.showWarningMessage(
                            'Discard this staged proposal?',
                            { modal: true },
                            'Discard'
                        );

                    if (answer !== 'Discard') return;

                    await fs.unlink(
                        path.join(STAGING, p.id + '.json')
                    );

                    vscode.window.showInformationMessage(
                        'Proposal rejected. No source changes.'
                    );
                } catch (error) {
                    vscode.window.showErrorMessage(String(error));
                }
            }
        )
    );

    // UNDO
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'forge-editor.undoEdit',
            async () => {
                if (applying) return;
                applying = true;

                try {
                    const records = await readUndo(context);

                    if (!records.length) {
                        vscode.window.showInformationMessage(
                            'Nothing to undo.'
                        );
                        return;
                    }

                    const record = records[0];
                    const target = await fs.realpath(record.file);

                    const folders =
                        vscode.workspace.workspaceFolders ?? [];

                    let allowed = false;

                    for (const folder of folders) {
                        const root = await fs.realpath(
                            folder.uri.fsPath
                        );

                        if (inside(root, target)) {
                            allowed = true;
                        }
                    }

                    if (!allowed) {
                        throw new Error(
                            'Affected repository is not open.'
                        );
                    }

                    const doc =
                        await vscode.workspace.openTextDocument(
                            vscode.Uri.file(target)
                        );

                    if (doc.isDirty) {
                        throw new Error(
                            'Save open changes before undo.'
                        );
                    }

                    const current = await fs.readFile(
                        target, 'utf8'
                    );

                    if (
                        hash(current) !== record.afterHash ||
                        doc.getText() !== current
                    ) {
                        throw new Error(
                            'File changed since application. ' +
                            'Automatic undo blocked.'
                        );
                    }

                    const answer =
                        await vscode.window.showWarningMessage(
                            'Restore original file?',
                            { modal: true },
                            'Undo'
                        );

                    if (answer !== 'Undo') return;

                    const edit = new vscode.WorkspaceEdit();

                    edit.replace(
                        doc.uri,
                        entireRange(doc),
                        record.before
                    );

                    if (!await vscode.workspace.applyEdit(edit)) {
                        throw new Error('Undo failed.');
                    }

                    if (!await doc.save()) {
                        throw new Error('Could not save undo.');
                    }

                    const restored = await fs.readFile(
                        target, 'utf8'
                    );

                    if (restored !== record.before) {
                        throw new Error(
                            'Undo verification failed.'
                        );
                    }

                    await fs.unlink(
                        path.join(undoDir(context), record.id + '.json')
                    );

                    vscode.window.showInformationMessage(
                        'Change undone successfully.'
                    );
                } catch (error) {
                    vscode.window.showErrorMessage(String(error));
                } finally {
                    applying = false;
                }
            }
        )
    );
}
