// ── Jump Graph webview ───────────────────────────────────────────────
//
// Runs inside the Jump Graph panel (bundled to out/webview/graph.js). The
// extension sends the project's jump graph and the location to centre on;
// this draws the part to show with Cytoscape.js and tells the extension
// which location or jump site the user clicked.

import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import {
  ALL_EDGES,
  buildViewGraph,
  type HostToWebview,
  type JumpGraphData,
  type JumpGraphViewState,
  type ViewEdge,
  type ViewNode,
  type WebviewToHost,
} from '../common/jumpGraphView';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHost): void;
  getState(): JumpGraphViewState | undefined;
  setState(state: JumpGraphViewState): void;
};

cytoscape.use(dagre);
const vscode = acquireVsCodeApi();

const state: JumpGraphViewState = vscode.getState() ?? {
  mode: 'around', depth: 2, followCursor: true, filter: { ...ALL_EDGES },
};
let graph: JumpGraphData = { nodes: [], edges: [], unresolved: [] };
let startFileUri: string | undefined;
let relPaths: Record<string, string> = {};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const info = $<HTMLDivElement>('info');
const notice = $<HTMLDivElement>('notice');

const cy = cytoscape({
  container: $('graph'),
  wheelSensitivity: 0.3,
  minZoom: 0.1,
  maxZoom: 3,
  boxSelectionEnabled: false,
});

// ── Colours from the VS Code theme ───────────────────────────────────

function themeColor(name: string, fallback: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}

function applyStyle(): void {
  const fg = themeColor('--vscode-editor-foreground', '#ccc');
  const bg = themeColor('--vscode-editorWidget-background', '#252526');
  const border = themeColor('--vscode-editorWidget-border', '#454545');
  const focus = themeColor('--vscode-focusBorder', '#007fd4');
  const error = themeColor('--vscode-errorForeground', '#f48771');
  const muted = themeColor('--vscode-descriptionForeground', '#999');
  const colors = {
    goto: themeColor('--vscode-charts-blue', '#3794ff'),
    gosub: themeColor('--vscode-charts-green', '#89d185'),
    func: themeColor('--vscode-charts-purple', '#b180d7'),
    desc: themeColor('--vscode-charts-orange', '#d18616'),
  };
  cy.style([
    {
      selector: 'node',
      style: {
        'label': 'data(label)', 'color': fg, 'font-size': 12, 'text-valign': 'center', 'text-halign': 'center',
        'shape': 'round-rectangle', 'width': 'label', 'height': 24, 'padding': '8px',
        'background-color': bg, 'border-width': 1, 'border-color': border,
      },
    },
    { selector: 'node.start', style: { 'border-width': 3, 'border-color': colors.gosub } },
    { selector: 'node.focus', style: { 'border-width': 3, 'border-color': focus } },
    { selector: 'node.unreachable', style: { 'color': muted, 'border-style': 'dashed' } },
    { selector: 'node.missing', style: { 'color': error, 'border-color': error, 'border-style': 'dashed' } },
    { selector: 'node.unknown', style: { 'shape': 'ellipse', 'width': 24, 'color': error, 'border-color': error } },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.9, 'width': 1.5,
        'line-color': colors.goto, 'target-arrow-color': colors.goto,
      },
    },
    { selector: 'edge.gosub', style: { 'line-style': 'dashed', 'line-color': colors.gosub, 'target-arrow-color': colors.gosub } },
    { selector: 'edge.func', style: { 'line-style': 'dotted', 'line-color': colors.func, 'target-arrow-color': colors.func } },
    { selector: 'edge.desc', style: { 'width': 1, 'line-color': colors.desc, 'target-arrow-color': colors.desc } },
    { selector: 'edge.unresolved', style: { 'line-style': 'dashed', 'line-color': error, 'target-arrow-color': error } },
    { selector: ':selected', style: { 'overlay-opacity': 0.15 } },
  ]);
}

// ── Drawing ──────────────────────────────────────────────────────────

function render(fit: boolean): void {
  const view = buildViewGraph(graph, {
    focus: state.focus,
    depth: state.mode === 'all' ? 'all' : state.depth,
    filter: state.filter,
    startFileUri,
  });
  notice.textContent = graph.nodes.length === 0 ? 'No locations yet.'
    : view.focusMissing ? `Location "${state.focus}" is not in the project; showing everything.` : '';

  cy.elements().remove();
  cy.add([
    ...view.nodes.map(n => ({
      group: 'nodes' as const,
      data: { id: n.id, label: n.isStart ? `▶ ${n.label}` : n.label, node: n },
      classes: [n.kind, n.isStart ? 'start' : '', n.isFocus ? 'focus' : '', n.unreachable ? 'unreachable' : ''].join(' '),
    })),
    ...view.edges.map(e => ({
      group: 'edges' as const,
      data: { id: e.id, source: e.source, target: e.target, edge: e },
      classes: [e.callType, e.unresolved ? 'unresolved' : ''].join(' '),
    })),
  ]);
  cy.layout({ name: 'dagre', rankDir: 'LR', nodeSep: 25, rankSep: 70, fit, padding: 30 } as cytoscape.LayoutOptions).run();
  if (!fit) {
    const focused = cy.$('node.focus');
    if (focused.nonempty()) cy.center(focused);
  }
  vscode.setState(state);
}

function place(uri: string | undefined, line: number | undefined): string {
  return uri === undefined ? '' : `${relPaths[uri] ?? uri}${line === undefined ? '' : `:${line + 1}`}`;
}

function describeNode(n: ViewNode): string {
  if (n.kind === 'unknown') return 'Jumps whose target is an expression the analysis cannot name.';
  if (n.kind === 'missing') return `${n.label} — not defined in the project`;
  const marks = [n.isStart ? 'start location' : '', n.unreachable ? 'nothing jumps here' : ''].filter(Boolean).join(', ');
  return `${n.label} — ${place(n.uri, n.line)}${marks ? ` (${marks})` : ''}`;
}

function describeEdge(e: ViewEdge): string {
  const target = e.unresolved ? e.exprs.join(', ') : e.target;
  const sites = e.sites.slice(0, 3).map(s => `${place(s.uri, s.line)} ${s.text}`).join(' · ');
  const more = e.sites.length > 3 ? ` · +${e.sites.length - 3} more` : '';
  return `${e.callType}: ${e.source} → ${target} — ${sites}${more}`;
}

cy.on('mouseover', 'node', ev => { info.textContent = describeNode(ev.target.data('node') as ViewNode); });
cy.on('mouseover', 'edge', ev => { info.textContent = describeEdge(ev.target.data('edge') as ViewEdge); });

cy.on('tap', 'node', ev => {
  const n = ev.target.data('node') as ViewNode;
  if (n.kind !== 'location' || n.uri === undefined || n.line === undefined) return;
  vscode.postMessage({ type: 'open', uri: n.uri, line: n.line });
});
// Double-click centres the graph on a location without leaving the panel.
cy.on('dbltap', 'node', ev => {
  const n = ev.target.data('node') as ViewNode;
  if (n.kind !== 'location') return;
  state.focus = n.id;
  state.mode = 'around';
  syncToolbar();
  render(true);
});
cy.on('tap', 'edge', ev => {
  const e = ev.target.data('edge') as ViewEdge;
  const s = e.sites[0];
  if (s) vscode.postMessage({ type: 'open', uri: s.uri, line: s.line });
});

// ── Toolbar ──────────────────────────────────────────────────────────

const modeSelect = $<HTMLSelectElement>('mode');
const depthSelect = $<HTMLSelectElement>('depth');
const followBox = $<HTMLInputElement>('follow');
const filterBoxes = document.querySelectorAll<HTMLInputElement>('input[data-filter]');

function syncToolbar(): void {
  modeSelect.value = state.mode;
  depthSelect.value = String(state.depth);
  depthSelect.disabled = state.mode === 'all';
  followBox.checked = state.followCursor;
  filterBoxes.forEach(box => { box.checked = state.filter[box.dataset.filter as keyof typeof state.filter]; });
}

modeSelect.addEventListener('change', () => { state.mode = modeSelect.value as JumpGraphViewState['mode']; syncToolbar(); render(true); });
depthSelect.addEventListener('change', () => { state.depth = Number(depthSelect.value); render(true); });
followBox.addEventListener('change', () => {
  state.followCursor = followBox.checked;
  vscode.setState(state);
  vscode.postMessage({ type: 'followCursor', enabled: state.followCursor });
});
filterBoxes.forEach(box => box.addEventListener('change', () => {
  state.filter = { ...state.filter, [box.dataset.filter!]: box.checked };
  render(false);
}));
$('fit').addEventListener('click', () => cy.fit(undefined, 30));

// ── Messages from the extension ──────────────────────────────────────

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  if (msg.type === 'graph') {
    const first = graph.nodes.length === 0;
    graph = msg.graph;
    startFileUri = msg.startFileUri;
    relPaths = msg.relPaths;
    render(first);
  } else if (msg.type === 'focus') {
    if (!msg.force && !state.followCursor) return;
    if (state.focus === msg.name && state.mode === 'around') return;
    state.focus = msg.name;
    state.mode = 'around';
    syncToolbar();
    render(true);
  }
});

// The theme's colours are CSS variables on <body>; VS Code swaps its class on a theme change.
new MutationObserver(() => { applyStyle(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

applyStyle();
syncToolbar();
vscode.postMessage({ type: 'followCursor', enabled: state.followCursor });
vscode.postMessage({ type: 'ready' });
