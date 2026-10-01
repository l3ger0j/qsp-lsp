// ── "QSP Libraries" view ─────────────────────────────────────────────
//
// A section of the Explorer side bar: the game's installed libraries and
// what the catalogs offer, with install / update / remove buttons. The
// tree model is src/common/libraryTree.ts; the work is libraryCommands.ts.

import * as vscode from 'vscode';
import type { CatalogLibrary } from '../common/libraryCatalog';
import { LIBRARY_FOLDER } from '../common/libraryConfig';
import type { AvailableNode, InstalledNode, LibraryTreeNode } from '../common/libraryTree';
import { workspaceRoot } from './gameConfig';
import { LibraryManager } from './libraryCommands';
import * as logger from './logger';
import { getActiveQspEditor, qspGlob } from './shared';

const VIEW_ID = 'qsp.libraries';

function installedState(node: InstalledNode): string {
  if (node.missing) return 'file missing';
  if (node.edited) return 'changed by hand';
  if (node.updateTo) return `${node.updateTo} available`;
  return '';
}

function installedIcon(node: InstalledNode): vscode.ThemeIcon {
  if (node.missing) return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
  if (node.edited) return new vscode.ThemeIcon('edit');
  if (node.updateTo) return new vscode.ThemeIcon('arrow-circle-up', new vscode.ThemeColor('list.warningForeground'));
  return new vscode.ThemeIcon('library');
}

function usageTooltip(md: vscode.MarkdownString, usage: string): void {
  md.appendMarkdown('\n\nAdd to the game:\n');
  md.appendCodeblock(usage, 'qsp');
}

class LibrariesProvider implements vscode.TreeDataProvider<LibraryTreeNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly manager: LibraryManager) {
    manager.onDidChange(() => this.changed.fire());
  }

  getChildren(node?: LibraryTreeNode): vscode.ProviderResult<LibraryTreeNode[]> {
    if (!node) return this.manager.tree();
    return node.kind === 'section' ? node.children : [];
  }

  getTreeItem(node: LibraryTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'section':
        return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      case 'installed': {
        const item = new vscode.TreeItem(node.name);
        item.description = [node.version, installedState(node)].filter(Boolean).join(' · ');
        item.iconPath = installedIcon(node);
        item.contextValue = node.missing || node.updateTo || node.edited ? 'qspLibraryInstalledUpdatable' : 'qspLibraryInstalled';
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${node.name}** ${node.version} — \`${node.sourcePath}\``);
        if (node.description) md.appendMarkdown(`\n\n${node.description}`);
        if (node.missing) md.appendMarkdown('\n\nThe file is gone: the game won\'t build until you update or remove the library.');
        if (node.edited) md.appendMarkdown('\n\nThe file was changed since it was installed; an update replaces the changes.');
        if (!node.inCatalog) md.appendMarkdown('\n\nNo catalog lists it now, so it can\'t be updated.');
        usageTooltip(md, node.usage);
        item.tooltip = md;
        if (!node.missing) item.command = { command: 'qsp.libraries.open', title: 'Open Library', arguments: [node] };
        return item;
      }
      case 'available': {
        const item = new vscode.TreeItem(node.name);
        item.description = node.version;
        item.iconPath = new vscode.ThemeIcon('cloud-download');
        item.contextValue = 'qspLibraryAvailable';
        const md = new vscode.MarkdownString(`**${node.name}** ${node.version}`);
        if (node.description) md.appendMarkdown(`\n\n${node.description}`);
        if (node.requires.length > 0) md.appendMarkdown(`\n\nAlso installs: ${node.requires.join(', ')}`);
        item.tooltip = md;
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.tooltip = node.text;
        item.iconPath = new vscode.ThemeIcon(node.severity === 'error' ? 'error' : node.severity === 'warning' ? 'warning' : 'info');
        if (node.action === 'openSettings') {
          item.command = { command: 'workbench.action.openSettings', title: 'Open Settings', arguments: ['qsp.libraries.sources'] };
        } else if (node.action === 'refresh') {
          item.command = { command: 'qsp.libraries.refresh', title: 'Refresh' };
        }
        return item;
      }
    }
  }
}

async function guarded(title: string, work: () => Promise<void>): Promise<void> {
  try {
    await vscode.window.withProgress({ location: { viewId: VIEW_ID }, title }, work);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.log(`[Libraries] ${title} failed: ${message}`);
    void vscode.window.showErrorMessage(message);
  }
}

async function insertUsage(usage: string): Promise<void> {
  const editor = getActiveQspEditor();
  if (!editor) {
    void vscode.window.showInformationMessage('Open a game file and put the cursor where the library should be loaded.');
    return;
  }
  const line = editor.selection.active.line;
  const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  await editor.edit(b => b.insert(new vscode.Position(line, 0), usage.split(/\r\n|\r|\n/).join(eol) + eol));
}

async function offerUsage(lib: CatalogLibrary, verb: string): Promise<void> {
  const insert = 'Insert at Cursor';
  const copy = 'Copy';
  const answer = await vscode.window.showInformationMessage(
    `${verb} ${lib.name} ${lib.version}. To use it, add to your game: ${lib.usage.split(/\r\n|\r|\n/).join('  ')}`,
    insert, copy);
  if (answer === insert) await insertUsage(lib.usage);
  if (answer === copy) await vscode.env.clipboard.writeText(lib.usage);
}

/** Register the view, its commands, and what keeps it up to date. */
export function registerLibrariesView(context: vscode.ExtensionContext): void {
  const manager = new LibraryManager(context, qspGlob(context));
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: new LibrariesProvider(manager) });

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = undefined; manager.refresh(); }, 300);
  };
  const root = workspaceRoot();
  if (root) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, `{txt2gam.json,${LIBRARY_FOLDER}/*.qsps}`));
    context.subscriptions.push(watcher, watcher.onDidChange(scheduleRefresh), watcher.onDidCreate(scheduleRefresh), watcher.onDidDelete(scheduleRefresh));
  }

  context.subscriptions.push(
    view,
    manager,
    { dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); } },
    vscode.commands.registerCommand('qsp.libraries.refresh', () => guarded('Loading the library catalogs', () => manager.reloadCatalogs())),
    vscode.commands.registerCommand('qsp.libraries.install', (node?: AvailableNode) => guarded('Installing a library', async () => {
      let id = node?.id;
      if (!id) {
        const available = await manager.available();
        if (available.length === 0) {
          void vscode.window.showInformationMessage('The catalogs have no library this game doesn\'t have yet.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          available.map(l => ({ label: l.name, description: l.version, detail: l.id, id: l.id })),
          { title: 'Add a QSP library', matchOnDetail: true });
        id = picked?.id;
      }
      if (!id) return;
      const lib = await manager.install(id);
      if (lib) void offerUsage(lib, 'Installed');
    })),
    vscode.commands.registerCommand('qsp.libraries.update', (node: InstalledNode) => guarded('Updating a library', async () => {
      const lib = await manager.install(node.id, { update: true });
      if (lib) void vscode.window.showInformationMessage(`Updated ${lib.name} to ${lib.version}.`);
    })),
    vscode.commands.registerCommand('qsp.libraries.remove', (node: InstalledNode) => guarded('Removing a library', async () => {
      await manager.remove(node.id);
    })),
    vscode.commands.registerCommand('qsp.libraries.copyUsage', async (node: InstalledNode) => {
      await vscode.env.clipboard.writeText(node.usage);
      void vscode.window.setStatusBarMessage(`Copied: ${node.usage.split(/\r\n|\r|\n/)[0]}`, 3000);
    }),
    vscode.commands.registerCommand('qsp.libraries.insertUsage', (node: InstalledNode) => insertUsage(node.usage)),
    vscode.commands.registerCommand('qsp.libraries.open', async (node: InstalledNode) => {
      const folder = workspaceRoot();
      if (folder) await vscode.window.showTextDocument(vscode.Uri.joinPath(folder, node.sourcePath), { preview: true });
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('qsp.libraries.sources')) void manager.reloadCatalogs();
    }),
  );
}
