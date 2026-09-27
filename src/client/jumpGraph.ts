// ── Jump Graph panel ─────────────────────────────────────────────────
//
// A webview tab beside the editor showing who jumps to or calls whom
// (src/webview/graph.ts draws it). The data is the server's
// `qsp/jumpGraph`; this side sends it over, follows the editor's cursor,
// and opens the location or jump site the user clicks.

import * as vscode from 'vscode';
import type { BaseLanguageClient } from 'vscode-languageclient';
import type { HostToWebview, JumpGraphData, WebviewToHost } from '../common/jumpGraphView';
import { onAnalysisSettled } from './analysisStatus';
import { projectStartFileUri } from './gameConfig';
import { getCurrentLocationBlock, qspGlob } from './shared';

const VIEW_TYPE = 'qsp.jumpGraph';

function nonce(): string {
  let s = '';
  for (let i = 0; i < 32; i++) s += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)];
  return s;
}

class JumpGraphPanel {
  static current: JumpGraphPanel | undefined;
  private followCursor = true;
  private ready = false;
  // A location asked for before the webview's script has loaded, when a
  // message would be lost.
  private pendingFocus: string | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  // One graph request at a time. While the server is busy (loading a large
  // project takes a minute) diagnostics keep changing; queuing a request
  // for each made the server answer them all at once, each reply megabytes
  // long, and run out of memory.
  private requesting = false;
  private staleWhileRequesting = false;
  // The last graph sent, so a refresh that changes nothing doesn't redraw.
  private lastGraphJson = '';
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly client: BaseLanguageClient,
  ) {
    const webviewRoot = vscode.Uri.joinPath(context.extensionUri, 'out', 'webview');
    panel.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };
    panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
    panel.webview.html = this.html(panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'graph.js')));

    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg)),
      panel.onDidDispose(() => this.dispose()),
      onAnalysisSettled(() => this.scheduleRefresh()),
      vscode.languages.onDidChangeDiagnostics(e => {
        if (e.uris.some(u => /\.(qsps|qsrc)$/i.test(u.path))) this.scheduleRefresh();
      }),
      vscode.window.onDidChangeTextEditorSelection(e => this.followEditor(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor(e => { if (e) this.followEditor(e); }),
      panel.onDidChangeViewState(() => { if (panel.visible) this.scheduleRefresh(); }),
    );
    JumpGraphPanel.current = this;
  }

  /** Centre on `name` (lowercase) even when the panel doesn't follow the cursor. */
  showLocation(name: string): void {
    if (this.ready) this.post({ type: 'focus', name, force: true });
    else this.pendingFocus = name;
  }

  private onMessage(msg: WebviewToHost): void {
    if (msg.type === 'ready') {
      this.ready = true;
      this.lastGraphJson = '';
      void this.refresh();
      if (this.pendingFocus !== undefined) {
        this.post({ type: 'focus', name: this.pendingFocus, force: true });
        this.pendingFocus = undefined;
      } else {
        const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find(e => e.document.languageId === 'qsp');
        if (editor) this.followEditor(editor);
      }
    } else if (msg.type === 'followCursor') {
      this.followCursor = msg.enabled;
    } else if (msg.type === 'open') {
      void this.open(msg.uri, msg.line);
    } else if (msg.type === 'log') {
      this.client.outputChannel.appendLine(msg.message);
    }
  }

  // Open in the editor group beside the panel, keeping the graph visible.
  private async open(uri: string, line: number): Promise<void> {
    const position = new vscode.Position(line, 0);
    const editorColumn = vscode.window.visibleTextEditors.find(e => e.viewColumn !== this.panel.viewColumn)?.viewColumn;
    await vscode.window.showTextDocument(vscode.Uri.parse(uri), {
      viewColumn: editorColumn ?? vscode.ViewColumn.One,
      selection: new vscode.Range(position, position),
    });
  }

  private followEditor(editor: vscode.TextEditor): void {
    if (!this.ready || !this.followCursor || editor.document.languageId !== 'qsp') return;
    const { current } = getCurrentLocationBlock(editor.document, editor.selection.active.line);
    if (current) this.post({ type: 'focus', name: current.name.toLowerCase(), force: false });
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refresh(); }, 300);
  }

  private async refresh(): Promise<void> {
    if (!this.ready || !this.panel.visible) return;
    if (this.requesting) {
      this.staleWhileRequesting = true;
      return;
    }
    this.requesting = true;
    try {
      await this.requestGraph();
    } finally {
      this.requesting = false;
      if (this.staleWhileRequesting) {
        this.staleWhileRequesting = false;
        this.scheduleRefresh();
      }
    }
  }

  private async requestGraph(): Promise<void> {
    const project = vscode.workspace.getConfiguration('qsp').get<boolean>('project.enabled', true);
    const active = vscode.window.activeTextEditor?.document;
    const scopeUri = project
      ? vscode.workspace.workspaceFolders?.[0]?.uri.toString()
      : active?.languageId === 'qsp' ? active.uri.toString() : undefined;
    if (!scopeUri) return;

    let graph: JumpGraphData;
    try {
      graph = await this.client.sendRequest<JumpGraphData>('qsp/jumpGraph', { uri: scopeUri });
    } catch {
      return; // The server isn't ready yet; the settled event refreshes again.
    }
    const relPaths: Record<string, string> = {};
    for (const n of graph.nodes) {
      if (n.uri && !(n.uri in relPaths)) relPaths[n.uri] = vscode.workspace.asRelativePath(vscode.Uri.parse(n.uri), false);
    }
    const startFileUri = project ? await projectStartFileUri(qspGlob(this.context)) : scopeUri;
    const json = JSON.stringify([graph, startFileUri]);
    if (json === this.lastGraphJson) return;
    this.lastGraphJson = json;
    this.post({ type: 'graph', graph, startFileUri, relPaths });
  }

  private post(msg: HostToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  private html(script: vscode.Uri): string {
    const n = nonce();
    const csp = `default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QSP Jump Graph</title>
<style nonce="${n}">
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  body { display: flex; flex-direction: column; color: var(--vscode-foreground); background: var(--vscode-editor-background);
         font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  #toolbar { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; padding: 6px 10px;
             border-bottom: 1px solid var(--vscode-panel-border); }
  #toolbar label { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  select, button { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
                   border: 1px solid var(--vscode-dropdown-border); padding: 1px 4px; }
  button { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; }
  .swatch { display: inline-block; width: 18px; border-top: 2px solid; vertical-align: middle; }
  .goto { border-color: var(--vscode-charts-blue); }
  .gosub { border-color: var(--vscode-charts-green); border-top-style: dashed; }
  .func { border-color: var(--vscode-charts-purple); border-top-style: dotted; }
  .desc { border-color: var(--vscode-charts-orange); }
  .unresolved { border-color: var(--vscode-errorForeground); border-top-style: dashed; }
  input:not([type]) { color: var(--vscode-input-foreground); background: var(--vscode-input-background);
                      border: 1px solid var(--vscode-input-border, transparent); width: 14em; }
  #status { margin-left: auto; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  #notice { color: var(--vscode-descriptionForeground); padding: 0 10px; }
  #notice a { color: var(--vscode-textLink-foreground); }
  #graph { flex: 1; min-height: 0; }
  #info { padding: 4px 10px; min-height: 1.4em; border-top: 1px solid var(--vscode-panel-border);
          color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
</head>
<body>
<div id="toolbar">
  <label>Show <select id="mode"><option value="around">around location</option><option value="all">whole project</option><option value="files">by file</option></select></label>
  <label>Depth <select id="depth"><option value="1">1</option><option value="2">2</option><option value="3">3</option></select></label>
  <label title="Locations that many others jump to or call (inventory, shared functions) tangle the graph">Hubs <select id="hubs">
    <option value="0">show all</option><option value="10">hide if 10+ callers</option><option value="20">hide if 20+ callers</option><option value="50">hide if 50+ callers</option>
  </select></label>
  <input id="search" list="locations" placeholder="Find location" spellcheck="false"><datalist id="locations"></datalist>
  <label><input type="checkbox" id="follow"> Follow cursor</label>
  <label><input type="checkbox" data-filter="goto"><span class="swatch goto"></span> goto</label>
  <label><input type="checkbox" data-filter="gosub"><span class="swatch gosub"></span> gosub</label>
  <label><input type="checkbox" data-filter="func"><span class="swatch func"></span> func</label>
  <label><input type="checkbox" data-filter="desc"><span class="swatch desc"></span> desc</label>
  <label><input type="checkbox" data-filter="unresolved"><span class="swatch unresolved"></span> unknown target</label>
  <button id="fit" title="Fit the graph to the panel">Fit</button>
  <span id="status"></span>
</div>
<div id="notice"></div>
<div id="graph"></div>
<div id="info">Click a location to open it, double-click to centre on it, double-click empty space to zoom in; click an arrow to open where the jump is written; hover to see its neighbours.</div>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (JumpGraphPanel.current === this) JumpGraphPanel.current = undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

/** Register the Jump Graph command and the panel's restore after a reload. */
export function registerJumpGraph(context: vscode.ExtensionContext, client: BaseLanguageClient): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('qsp.showJumpGraph', (arg?: unknown) => {
      // From the QSP Locations view: centre on that location.
      const name = (arg as { name?: unknown } | undefined)?.name;
      let graph = JumpGraphPanel.current;
      if (graph) {
        graph.panel.reveal(undefined, true);
      } else {
        const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'QSP Jump Graph',
          { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { retainContextWhenHidden: true });
        graph = new JumpGraphPanel(panel, context, client);
      }
      if (typeof name === 'string') graph.showLocation(name.toLowerCase());
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        // The webview restores its own settings from vscode.getState().
        new JumpGraphPanel(panel, context, client);
      },
    }),
    { dispose: () => JumpGraphPanel.current?.dispose() },
  );
}
