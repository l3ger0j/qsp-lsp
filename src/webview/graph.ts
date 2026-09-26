// ── Jump Graph webview ───────────────────────────────────────────────
//
// Runs inside the Jump Graph panel (bundled to out/webview/graph.js). The
// extension sends the project's jump graph and the location to centre on;
// this draws the part to show with Cytoscape.js and tells the extension
// which location or jump site the user clicked. Placing the nodes is up
// to src/common/jumpGraphLayout.ts.

import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { chooseLayout, ForceLayout, nodesNear, seedFromCache, type LayoutEdge, type LayoutNode, type Positions } from '../common/jumpGraphLayout';
import {
  ALL_EDGES,
  buildViewGraph,
  foldByFile,
  type HostToWebview,
  type JumpGraphData,
  type JumpGraphViewState,
  type ViewEdge,
  type ViewGraph,
  type ViewNode,
  type WebviewToHost,
} from '../common/jumpGraphView';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHost): void;
  getState(): Partial<JumpGraphViewState> | undefined;
  setState(state: JumpGraphViewState): void;
};

cytoscape.use(dagre);
const vscode = acquireVsCodeApi();

// Saved state from an older version of the panel lacks the newer fields.
const state: JumpGraphViewState = {
  mode: 'around', depth: 2, followCursor: true, filter: { ...ALL_EDGES }, hubThreshold: 20, expandedFiles: [],
  ...vscode.getState(),
};
let graph: JumpGraphData = { nodes: [], edges: [], unresolved: [] };
let startFileUri: string | undefined;
let relPaths: Record<string, string> = {};

// From this many nodes the graph is drawn the cheap way: straight edges,
// and a snapshot instead of the graph while panning and zooming.
const LARGE_GRAPH = 250;
let large = false;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const info = $<HTMLDivElement>('info');
const notice = $<HTMLDivElement>('notice');
const status = $<HTMLSpanElement>('status');

const cy = cytoscape({
  container: $('graph'),
  wheelSensitivity: 0.3,
  minZoom: 0.02,
  maxZoom: 3,
  boxSelectionEnabled: false,
});

// ── Colours from the VS Code theme ───────────────────────────────────

function themeColor(name: string, fallback: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}

const fontFamily = themeColor('--vscode-font-family', 'sans-serif');
const LABEL_SIZE = 12;
const FILE_LABEL_SIZE = 14;

// Node widths come from the label; measured here because Cytoscape's own
// `width: label` is deprecated.
const measure = document.createElement('canvas').getContext('2d')!;
function textWidth(text: string, size: number, bold: boolean): number {
  measure.font = `${bold ? 'bold ' : ''}${size}px ${fontFamily}`;
  return Math.ceil(measure.measureText(text).width);
}

function applyStyle(): void {
  const fg = themeColor('--vscode-editor-foreground', '#ccc');
  const bg = themeColor('--vscode-editorWidget-background', '#252526');
  const editorBg = themeColor('--vscode-editor-background', '#1e1e1e');
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
        'label': 'data(label)', 'color': fg, 'font-family': fontFamily, 'font-size': LABEL_SIZE,
        'text-valign': 'center', 'text-halign': 'center',
        'shape': 'round-rectangle', 'width': 'data(width)', 'height': 24, 'padding': '8px',
        'background-color': bg, 'border-width': 1, 'border-color': border,
        // Unreadable labels are skipped when zoomed out, which also keeps large graphs fast.
        'min-zoomed-font-size': 7,
      },
    },
    { selector: 'node.start', style: { 'border-width': 3, 'border-color': colors.gosub } },
    { selector: 'node.focus', style: { 'border-width': 3, 'border-color': focus } },
    { selector: 'node.unreachable', style: { 'color': muted, 'border-style': 'dashed' } },
    { selector: 'node.missing', style: { 'color': error, 'border-color': error, 'border-style': 'dashed' } },
    { selector: 'node.unknown', style: { 'shape': 'ellipse', 'width': 24, 'color': error, 'border-color': error } },
    { selector: 'node.file', style: { 'font-weight': 'bold', 'font-size': FILE_LABEL_SIZE, 'border-width': 2, 'height': 32 } },
    {
      selector: 'node.file.expanded',
      style: {
        'text-valign': 'top', 'text-margin-y': -4, 'background-color': editorBg, 'background-opacity': 0.6,
        'border-style': 'dashed', 'padding': '14px',
      },
    },
    {
      selector: 'edge',
      style: {
        'curve-style': large ? 'straight' : 'bezier', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.9, 'width': 1.5,
        'line-color': colors.goto, 'target-arrow-color': colors.goto,
      },
    },
    { selector: 'edge.gosub', style: { 'line-style': 'dashed', 'line-color': colors.gosub, 'target-arrow-color': colors.gosub } },
    { selector: 'edge.func', style: { 'line-style': 'dotted', 'line-color': colors.func, 'target-arrow-color': colors.func } },
    { selector: 'edge.desc', style: { 'width': 1, 'line-color': colors.desc, 'target-arrow-color': colors.desc } },
    { selector: 'edge.mixed', style: { 'line-color': muted, 'target-arrow-color': muted } },
    { selector: 'edge.unresolved', style: { 'line-style': 'dashed', 'line-color': error, 'target-arrow-color': error } },
    {
      selector: 'edge.counted',
      style: {
        'width': 'data(width)', 'label': 'data(count)', 'font-size': 10, 'color': muted, 'min-zoomed-font-size': 7,
        'text-background-color': editorBg, 'text-background-opacity': 1, 'text-background-padding': '2px',
      },
    },
    { selector: ':selected', style: { 'overlay-opacity': 0.15 } },
    { selector: 'node:selected', style: { 'border-width': 3, 'border-color': focus } },
    { selector: '.faded', style: { 'opacity': 0.15 } },
  ]);
}

// Cytoscape takes these only as constructor options but reads them off the
// renderer on every frame, and whether the graph is large is known only
// once it's built.
function tuneViewport(): void {
  const r = (cy as unknown as { renderer(): { hideEdgesOnViewport?: boolean; textureOnViewport?: boolean } | undefined }).renderer();
  if (!r) return;
  r.hideEdgesOnViewport = large;
  r.textureOnViewport = large;
}

// ── Building the view ────────────────────────────────────────────────

function currentView(): ViewGraph {
  const view = buildViewGraph(graph, {
    focus: state.focus,
    depth: state.mode === 'around' ? state.depth : 'all',
    filter: state.filter,
    startFileUri,
    hubThreshold: state.hubThreshold,
  });
  return state.mode === 'files' ? foldByFile(view, new Set(state.expandedFiles)) : view;
}

function nodeLabel(n: ViewNode): string {
  let label = n.kind === 'file' ? `${relPaths[n.uri!] ?? n.label} (${n.locationCount})` : n.label;
  if (n.isStart) label = `▶ ${label}`;
  if (n.hubCalls) label += `  ↗${n.hubCalls.length}`;
  return label;
}

function elements(view: ViewGraph, positions: Positions | undefined): cytoscape.ElementDefinition[] {
  const counted = state.mode === 'files';
  return [
    ...view.nodes.map(n => {
      const label = nodeLabel(n);
      return {
        group: 'nodes' as const,
        position: positions?.get(n.id),
        data: {
          id: n.id, label, node: n, parent: n.parent,
          width: n.kind === 'file' ? textWidth(label, FILE_LABEL_SIZE, true) : textWidth(label, LABEL_SIZE, false),
        },
        classes: [
          n.kind, n.isStart ? 'start' : '', n.isFocus ? 'focus' : '', n.unreachable ? 'unreachable' : '', n.expanded ? 'expanded' : '',
        ].join(' '),
      };
    }),
    ...view.edges.map(e => ({
      group: 'edges' as const,
      data: {
        id: e.id, source: e.source, target: e.target, edge: e,
        count: e.siteCount, width: Math.min(6, 1 + Math.log2(e.siteCount)),
      },
      classes: [
        e.callTypes.length > 1 ? 'mixed' : e.callType, e.unresolved ? 'unresolved' : '', counted && e.siteCount > 1 ? 'counted' : '',
      ].join(' '),
    })),
  ];
}

function showNotices(view: ViewGraph): void {
  notice.replaceChildren();
  if (graph.nodes.length === 0) {
    notice.textContent = 'No locations yet.';
    return;
  }
  if (view.focusMissing) {
    notice.append(`Location "${state.focus}" is not in the project; showing everything. `);
  }
  if (view.hiddenHubs.length > 0) {
    notice.append(`Hidden hubs (called from ${state.hubThreshold}+ locations; click to centre on one): `);
    const shown = view.hiddenHubs.slice(0, 10);
    shown.forEach((hub, i) => {
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = hub.label;
      link.title = `Called from ${hub.callers} locations`;
      link.addEventListener('click', ev => {
        ev.preventDefault();
        centreOn(hub.id);
      });
      notice.append(link, ` (${hub.callers})${i < shown.length - 1 ? ', ' : ''}`);
    });
    if (view.hiddenHubs.length > shown.length) notice.append(` and ${view.hiddenHubs.length - shown.length} more`);
  }
}

// ── Layout ───────────────────────────────────────────────────────────

// Places per view (mode, focus, depth), so a redraw after an edit, or
// coming back to a view seen before, doesn't shuffle the picture.
const positionCache = new Map<string, Positions>();
const POSITION_CACHE_SIZE = 8;
let layoutKey = '';
// Bumped on every render so a force layout still running for an older
// render stops.
let layoutRun = 0;

function viewKey(): string {
  return state.mode === 'around' ? `around\u0000${state.focus ?? ''}\u0000${state.depth}` : state.mode;
}

function rememberPositions(): void {
  const positions: Positions = new Map();
  cy.nodes().forEach(n => { positions.set(n.id(), { ...n.position() }); });
  positionCache.delete(layoutKey);
  positionCache.set(layoutKey, positions);
  if (positionCache.size > POSITION_CACHE_SIZE) positionCache.delete(positionCache.keys().next().value!);
}

// Outer size of a node as Cytoscape will draw it (label, 8px padding,
// border), known before the node exists so the layout can run first.
function nodeSize(n: ViewNode): { width: number; height: number } {
  if (n.kind === 'unknown') return { width: 42, height: 42 };
  const file = n.kind === 'file';
  return {
    width: textWidth(nodeLabel(n), file ? FILE_LABEL_SIZE : LABEL_SIZE, file) + 22,
    height: (file ? 32 : 24) + 22,
  };
}

// Lays the view out first and hands it to Cytoscape once, with the nodes
// in place: redrawing a graph of thousands of arrows at every step of a
// force layout took ten times longer than the layout itself. The old
// picture stays up meanwhile.
function render(fit: boolean): void {
  const view = currentView();
  showNotices(view);
  const run = ++layoutRun;
  const key = viewKey();
  vscode.setState(state);

  // An expanded file is a compound node: Cytoscape fits it around its locations.
  const nodes: LayoutNode[] = view.nodes.filter(n => !n.expanded).map(n => ({ id: n.id, ...nodeSize(n), group: n.parent }));
  const edges: LayoutEdge[] = view.edges.map(e => ({ source: e.source, target: e.target }));
  const count = (kind: ViewNode['kind']) => view.nodes.filter(n => n.kind === kind).length;
  const parts = state.mode === 'files' ? [`${count('file')} files`] : [];
  if (state.mode !== 'files' || count('location') > 0) parts.push(`${count('location')} locations`);
  const summary = `${parts.join(', ')}, ${view.edges.length} arrows`;
  const started = performance.now();

  // `positions` undefined: small enough for dagre, which Cytoscape runs.
  const draw = (positions: Positions | undefined, how: string | undefined, placedBefore: boolean) => {
    if (run !== layoutRun) return;
    if (large !== view.nodes.length >= LARGE_GRAPH) {
      large = !large;
      applyStyle();
    }
    tuneViewport();
    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements(view, positions));
    });
    if (!positions) cy.layout({ name: 'dagre', rankDir: 'LR', nodeSep: 25, rankSep: 70, fit: false, padding: 30 } as cytoscape.LayoutOptions).run();
    layoutKey = key;
    rememberPositions();
    if (fit) {
      cy.fit(undefined, 30);
    } else if (!placedBefore) {
      const focused = cy.$('node.focus');
      if (focused.nonempty()) cy.center(focused);
    }
    status.textContent = summary;
    if (how) vscode.postMessage({ type: 'log', message: `Jump graph: ${summary} laid out (${how}) in ${Math.round(performance.now() - started)} ms` });
  };

  const seeded = seedFromCache(nodes, edges, positionCache.get(key));
  if (seeded && seeded.fresh.length === 0) {
    draw(seeded.positions, undefined, true);
  } else if (seeded) {
    // Only the new nodes move, so the simulation needs just them and what
    // they could bump into, not the whole graph.
    const fresh = new Set(seeded.fresh);
    const near = nodesNear(seeded.positions, fresh, 400);
    const pinned = new Set([...near].filter(id => !fresh.has(id)));
    const layout = new ForceLayout(nodes.filter(n => near.has(n.id)), edges.filter(e => near.has(e.source) && near.has(e.target)), { seed: seeded.positions, pinned });
    runForce(layout, run, () => {
      for (const [id, p] of layout.positions()) seeded.positions.set(id, p);
      draw(seeded.positions, `${fresh.size} new`, true);
    });
  } else if (chooseLayout(nodes.length, edges.length) === 'layered') {
    draw(undefined, 'layered', false);
  } else {
    const layout = new ForceLayout(nodes, edges);
    runForce(layout, run, () => draw(layout.positions(), 'force', false));
  }
}

// Runs the simulation in short slices so the panel keeps responding.
function runForce(layout: ForceLayout, run: number, done: () => void): void {
  const slice = () => {
    if (run !== layoutRun) return;
    if (layout.step(40)) {
      done();
    } else {
      status.textContent = `Laying out… ${Math.round(layout.progress * 100)}%`;
      setTimeout(slice, 0);
    }
  };
  slice();
}

// ── Pointer ──────────────────────────────────────────────────────────

function place(uri: string | undefined, line: number | undefined): string {
  return uri === undefined ? '' : `${relPaths[uri] ?? uri}${line === undefined ? '' : `:${line + 1}`}`;
}

function describeNode(n: ViewNode): string {
  if (n.kind === 'unknown') return 'Jumps whose target is an expression the analysis cannot name.';
  if (n.kind === 'missing') return `${n.label} — not defined in the project`;
  if (n.kind === 'file') {
    return `${place(n.uri, undefined)} — ${n.locationCount} locations; click to ${n.expanded ? 'fold' : 'open'} it`;
  }
  const marks = [
    n.isStart ? 'start location' : '',
    n.unreachable ? 'nothing jumps here' : '',
    n.hubCalls ? `calls hidden hubs: ${n.hubCalls.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  return `${n.label} — ${place(n.uri, n.line)}${marks ? ` (${marks})` : ''}`;
}

function describeEdge(e: ViewEdge): string {
  const label = (id: string) => (cy.getElementById(id).data('node') as ViewNode | undefined)?.label ?? id;
  const target = e.unresolved ? e.exprs.join(', ') : label(e.target);
  const sites = e.sites.map(s => `${place(s.uri, s.line)} ${s.text}`).join(' · ');
  const more = e.siteCount > e.sites.length ? ` · +${e.siteCount - e.sites.length} more` : '';
  return `${e.callTypes.join('/')}: ${label(e.source)} → ${target} — ${sites}${more}`;
}

// Fade everything but the hovered location and its neighbours.
function highlight(node: cytoscape.NodeSingular): void {
  if (node.isParent()) return;
  const keep = node.closedNeighborhood();
  cy.batch(() => {
    cy.elements().not(keep.union(keep.ancestors())).addClass('faded');
  });
}

cy.on('mouseover', 'node', ev => {
  info.textContent = describeNode(ev.target.data('node') as ViewNode);
  highlight(ev.target as cytoscape.NodeSingular);
});
cy.on('mouseout', 'node', () => { cy.batch(() => { cy.elements('.faded').removeClass('faded'); }); });
cy.on('mouseover', 'edge', ev => { info.textContent = describeEdge(ev.target.data('edge') as ViewEdge); });

cy.on('tap', 'node', ev => {
  const n = ev.target.data('node') as ViewNode;
  if (n.kind === 'file') {
    state.expandedFiles = n.expanded ? state.expandedFiles.filter(u => u !== n.uri) : [...state.expandedFiles, n.uri!];
    // Most of the picture is laid out again, so the old viewport points nowhere useful.
    render(true);
    return;
  }
  if (n.kind !== 'location' || n.uri === undefined || n.line === undefined) return;
  vscode.postMessage({ type: 'open', uri: n.uri, line: n.line });
});
// Double-click centres the graph on a location without leaving the panel.
cy.on('dbltap', 'node', ev => {
  const n = ev.target.data('node') as ViewNode;
  if (n.kind === 'location') centreOn(n.id);
});
cy.on('tap', 'edge', ev => {
  const e = ev.target.data('edge') as ViewEdge;
  const s = e.sites[0];
  if (s) vscode.postMessage({ type: 'open', uri: s.uri, line: s.line });
});
// A node dragged by hand stays where it was put on the next redraw.
cy.on('dragfree', 'node', () => rememberPositions());

function centreOn(id: string): void {
  state.focus = id;
  state.mode = 'around';
  syncToolbar();
  render(true);
}

// ── Search ───────────────────────────────────────────────────────────

const search = $<HTMLInputElement>('search');
const names = $<HTMLDataListElement>('locations');
let listedNames = '';

function fillSearchList(): void {
  const labels = graph.nodes.filter(n => !n.missing).map(n => n.name).sort((a, b) => a.localeCompare(b));
  const joined = labels.join('\u0000');
  if (joined === listedNames) return;
  listedNames = joined;
  names.replaceChildren(...labels.map(label => {
    const option = document.createElement('option');
    option.value = label;
    return option;
  }));
}

function find(text: string): void {
  const id = text.trim().toLowerCase();
  if (!id) return;
  if (!graph.nodes.some(n => !n.missing && n.name.toLowerCase() === id)) {
    status.textContent = `No location "${text.trim()}"`;
    return;
  }
  // Not drawn: a hidden hub, a location in a folded file, or one outside the neighbourhood.
  if (!reveal(id)) centreOn(id);
}

// Select a drawn location and pan to it, keeping the layout.
function reveal(id: string): boolean {
  const node = cy.getElementById(id);
  if (node.empty()) return false;
  cy.$(':selected').unselect();
  node.select();
  cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1) }, { duration: 250 });
  return true;
}

search.addEventListener('change', () => find(search.value));

// ── Toolbar ──────────────────────────────────────────────────────────

const modeSelect = $<HTMLSelectElement>('mode');
const depthSelect = $<HTMLSelectElement>('depth');
const hubSelect = $<HTMLSelectElement>('hubs');
const followBox = $<HTMLInputElement>('follow');
const filterBoxes = document.querySelectorAll<HTMLInputElement>('input[data-filter]');

function syncToolbar(): void {
  modeSelect.value = state.mode;
  depthSelect.value = String(state.depth);
  depthSelect.disabled = state.mode !== 'around';
  hubSelect.value = String(state.hubThreshold);
  followBox.checked = state.followCursor;
  filterBoxes.forEach(box => { box.checked = state.filter[box.dataset.filter as keyof typeof state.filter]; });
}

modeSelect.addEventListener('change', () => { state.mode = modeSelect.value as JumpGraphViewState['mode']; syncToolbar(); render(true); });
depthSelect.addEventListener('change', () => { state.depth = Number(depthSelect.value); render(true); });
hubSelect.addEventListener('change', () => { state.hubThreshold = Number(hubSelect.value); render(false); });
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
    fillSearchList();
    render(first);
  } else if (msg.type === 'focus') {
    if (!msg.force && !state.followCursor) return;
    if (state.focus === msg.name && state.mode === 'around') return;
    // Rebuilding a whole-project or by-file picture on every click in the
    // editor would be slow and lose the user's bearings; point at the
    // location in it instead. Only a command switches to its neighbourhood.
    if (!msg.force && state.mode !== 'around') {
      reveal(msg.name);
      return;
    }
    centreOn(msg.name);
  }
});

// The theme's colours are CSS variables on <body>; VS Code swaps its class on a theme change.
new MutationObserver(() => { applyStyle(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

applyStyle();
syncToolbar();
vscode.postMessage({ type: 'followCursor', enabled: state.followCursor });
vscode.postMessage({ type: 'ready' });
