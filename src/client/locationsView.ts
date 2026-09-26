// ── "QSP Locations" view ─────────────────────────────────────────────
//
// A section of the Explorer side bar listing the project's locations (or
// the active file's, when project mode is off), grouped by file or as one
// alphabetical list. The tree model is src/common/locationTree.ts; the
// data comes from the server's `qsp/listLocations`.

import * as vscode from 'vscode';
import type { BaseLanguageClient } from 'vscode-languageclient';
import {
  buildLocationTree,
  findLocationNode,
  parentIndex,
  type DiagnosticMark,
  type LocationGrouping,
  type LocationItem,
  type LocationNode,
  type LocationTreeNode,
} from '../common/locationTree';
import { onAnalysisSettled } from './analysisStatus';
import { orderedProjectUris, readGameConfig } from './gameConfig';
import { getCurrentLocationBlock, qspGlob } from './shared';

const VIEW_ID = 'qsp.locations';
const GROUPING_KEY = 'qsp.locations.grouping';
// More top-level folders/files than this start collapsed.
const EXPAND_LIMIT = 20;

function projectEnabled(): boolean {
  return vscode.workspace.getConfiguration('qsp').get<boolean>('project.enabled', true);
}

function toMark(d: vscode.Diagnostic): DiagnosticMark {
  return {
    line: d.range.start.line,
    severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error'
      : d.severity === vscode.DiagnosticSeverity.Warning ? 'warning' : 'other',
  };
}

class LocationsProvider implements vscode.TreeDataProvider<LocationTreeNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: LocationTreeNode[] = [];
  private parents = new Map<string, LocationTreeNode>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: BaseLanguageClient,
    private readonly view: () => vscode.TreeView<LocationTreeNode> | undefined,
  ) {}

  get grouping(): LocationGrouping {
    return this.context.workspaceState.get<LocationGrouping>(GROUPING_KEY, 'file');
  }

  async setGrouping(grouping: LocationGrouping): Promise<void> {
    await this.context.workspaceState.update(GROUPING_KEY, grouping);
    await vscode.commands.executeCommand('setContext', GROUPING_KEY, grouping);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const project = projectEnabled();
    const active = vscode.window.activeTextEditor?.document;
    const scopeUri = project
      ? vscode.workspace.workspaceFolders?.[0]?.uri.toString()
      : active?.languageId === 'qsp' ? active.uri.toString() : undefined;

    let items: LocationItem[] = [];
    if (scopeUri) {
      try {
        items = await this.client.sendRequest<LocationItem[]>('qsp/listLocations', { uri: scopeUri });
      } catch {
        // The server isn't ready yet; the settled event refreshes again.
      }
    }

    this.roots = buildLocationTree(items, {
      grouping: this.grouping,
      relPath: uri => vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false).replace(/\\/g, '/'),
      startFileUri: project ? await this.startFileUri() : scopeUri,
      diagnostics: uri => vscode.languages.getDiagnostics(vscode.Uri.parse(uri)).map(toMark),
    });
    this.parents = parentIndex(this.roots);

    const view = this.view();
    if (view) {
      view.message = items.length > 0 ? undefined
        : project ? 'No locations in the project yet.' : 'Open a QSP file to see its locations.';
    }
    this.changed.fire();
  }

  // The file the game starts from, ordered as the build orders it. A broken
  // txt2gam.json or mainFile pattern just leaves the start unmarked here;
  // the build reports it.
  private async startFileUri(): Promise<string | undefined> {
    try {
      const uris = await orderedProjectUris(await readGameConfig(), qspGlob(this.context));
      return uris[0]?.toString();
    } catch {
      return undefined;
    }
  }

  /** The location node around `line` of `uri`, for revealing the cursor's location. */
  locationAt(uri: string, line: number): LocationNode | undefined {
    return findLocationNode(this.roots, uri, line);
  }

  getChildren(node?: LocationTreeNode): LocationTreeNode[] {
    if (!node) return this.roots;
    return node.kind === 'location' ? [] : node.children;
  }

  getParent(node: LocationTreeNode): LocationTreeNode | undefined {
    return this.parents.get(node.id);
  }

  getTreeItem(node: LocationTreeNode): vscode.TreeItem {
    if (node.kind !== 'location') {
      const state = this.roots.length > EXPAND_LIMIT
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded;
      const item = new vscode.TreeItem(node.label, state);
      item.id = node.id;
      if (node.kind === 'file') {
        // resourceUri gives the file its icon from the file icon theme.
        item.resourceUri = vscode.Uri.parse(node.uri);
        item.description = `${node.children.length}`;
        item.tooltip = node.relPath;
      } else {
        item.iconPath = vscode.ThemeIcon.Folder;
      }
      return item;
    }

    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.contextValue = 'qspLocation';
    item.command = { title: 'Open Location', command: 'qsp.locations.open', arguments: [node] };

    const problems = [
      node.errors ? `${node.errors} error${node.errors === 1 ? '' : 's'}` : '',
      node.warnings ? `${node.warnings} warning${node.warnings === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(', ');
    item.description = [this.grouping === 'flat' ? node.relPath : '', problems].filter(Boolean).join(' · ');
    item.iconPath = node.errors
      ? new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'))
      : node.warnings
        ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
        : new vscode.ThemeIcon(node.isStart ? 'play' : 'symbol-namespace');

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${node.name.replace(/[\\`*_[\]]/g, '\\$&')}**`);
    if (node.isStart) tooltip.appendMarkdown(' — start location');
    tooltip.appendMarkdown(`\n\n${node.relPath}, lines ${node.line + 1}–${node.endLine + 1}`);
    if (problems) tooltip.appendMarkdown(`\n\n${problems}`);
    item.tooltip = tooltip;
    return item;
  }
}

/** Register the view, its commands, and what keeps it up to date. */
export function registerLocationsView(context: vscode.ExtensionContext, client: BaseLanguageClient): void {
  // The provider reads the view only after it exists (on refresh).
  const provider: LocationsProvider = new LocationsProvider(context, client, (): vscode.TreeView<LocationTreeNode> => view);
  const view: vscode.TreeView<LocationTreeNode> = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = undefined; void provider.refresh(); }, 300);
  };

  // Follow the cursor: select the location being edited, without taking focus.
  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  const revealCursor = () => {
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
      revealTimer = undefined;
      const editor = vscode.window.activeTextEditor;
      if (!view.visible || !editor || editor.document.languageId !== 'qsp') return;
      if (!vscode.workspace.getConfiguration('qsp').get<boolean>('locations.followCursor', true)) return;
      const { current } = getCurrentLocationBlock(editor.document, editor.selection.active.line);
      const node = current && provider.locationAt(editor.document.uri.toString(), current.startLine);
      if (node) void view.reveal(node, { select: true, focus: false, expand: true });
    }, 200);
  };

  void vscode.commands.executeCommand('setContext', GROUPING_KEY, provider.grouping);
  void updateHasSources(context);

  context.subscriptions.push(
    view,
    { dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); if (revealTimer) clearTimeout(revealTimer); } },
    vscode.commands.registerCommand('qsp.locations.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('qsp.locations.groupByFile', () => provider.setGrouping('file')),
    vscode.commands.registerCommand('qsp.locations.groupFlat', () => provider.setGrouping('flat')),
    vscode.commands.registerCommand('qsp.locations.open', (node: LocationNode) => openLocation(node)),
    vscode.commands.registerCommand('qsp.locations.findReferences', (node: LocationNode) => findReferences(node)),
    onAnalysisSettled(scheduleRefresh),
    vscode.languages.onDidChangeDiagnostics(e => {
      if (e.uris.some(u => /\.(qsps|qsrc)$/i.test(u.path))) scheduleRefresh();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (!projectEnabled()) scheduleRefresh();
      revealCursor();
    }),
    vscode.window.onDidChangeTextEditorSelection(revealCursor),
    view.onDidChangeVisibility(() => { if (view.visible) { scheduleRefresh(); revealCursor(); } }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('qsp.project.enabled')) scheduleRefresh();
    }),
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.languageId === 'qsp') void vscode.commands.executeCommand('setContext', 'qsp.hasSources', true);
    }),
  );
}

// The view only appears in workspaces that have QSP sources.
async function updateHasSources(context: vscode.ExtensionContext): Promise<void> {
  const openQsp = vscode.workspace.textDocuments.some(d => d.languageId === 'qsp');
  const found = openQsp || (await vscode.workspace.findFiles(qspGlob(context), undefined, 1)).length > 0;
  await vscode.commands.executeCommand('setContext', 'qsp.hasSources', found);
}

/** Open a location's file with the cursor on its header. */
export async function openLocation(node: { uri: string; line: number }): Promise<vscode.TextEditor> {
  const position = new vscode.Position(node.line, 0);
  return vscode.window.showTextDocument(vscode.Uri.parse(node.uri), {
    selection: new vscode.Range(position, position),
    preview: true,
  });
}

// References to a location, shown in the peek view like Shift+F12.
async function findReferences(node: LocationNode): Promise<void> {
  const editor = await openLocation(node);
  const header = editor.document.lineAt(node.line).text;
  const position = new vscode.Position(node.line, Math.max(header.indexOf(node.name), 0));
  const refs = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeReferenceProvider', editor.document.uri, position,
  );
  await vscode.commands.executeCommand('editor.action.showReferences', editor.document.uri, position, refs ?? []);
}
