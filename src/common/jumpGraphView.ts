// ── Jump graph view model ────────────────────────────────────────────
//
// What the Jump Graph webview draws: the server's jump graph filtered by
// call type and cut down to the neighbourhood of one location (or kept
// whole), with the start location, unreachable locations and jumps to
// unknown targets marked. Pure, shared by the webview and the tests.

/** Wire shape of `qsp/jumpGraph` (see src/server/jumpGraph.ts). */
export interface JumpGraphData {
  nodes: Array<{ name: string; uri?: string; line?: number; missing?: boolean }>;
  edges: Array<{ from: string; to: string; callType: CallType; kind: 'exact'; sites: JumpSite[] }>;
  unresolved: Array<{ from: string; callType: CallType; expr: string; site: JumpSite }>;
}

export type CallType = 'goto' | 'gosub' | 'func' | 'desc';
export interface JumpSite { uri: string; line: number; text: string }

export interface EdgeFilter {
  goto: boolean;
  gosub: boolean;
  func: boolean;
  desc: boolean;
  /** Jumps whose target the analysis can't name, drawn to a "?" node. */
  unresolved: boolean;
}

export const ALL_EDGES: EdgeFilter = { goto: true, gosub: true, func: true, desc: true, unresolved: true };

export interface ViewNode {
  id: string;
  label: string;
  kind: 'location' | 'missing' | 'unknown';
  uri?: string;
  line?: number;
  isStart: boolean;
  isFocus: boolean;
  /** No other location jumps or calls here, and it isn't the start. */
  unreachable: boolean;
}

export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  callType: CallType;
  unresolved: boolean;
  sites: JumpSite[];
  /** For an unresolved edge, the target expressions (`$next`, …). */
  exprs: string[];
}

export interface ViewGraph {
  nodes: ViewNode[];
  edges: ViewEdge[];
  /** The focus asked for isn't in the graph (renamed, deleted, or filtered out). */
  focusMissing: boolean;
}

export interface ViewOptions {
  /** Lowercase location name to centre on; undefined centres on the start location. */
  focus?: string;
  /** Steps from the focus, in either direction; `'all'` keeps the whole graph. */
  depth: number | 'all';
  filter: EdgeFilter;
  /** The file the game starts from; its first location is the start. */
  startFileUri?: string;
}

const unknownId = (from: string) => `?:${from}`;

/** Cut `graph` down to what the view shows. */
export function buildViewGraph(graph: JumpGraphData, opts: ViewOptions): ViewGraph {
  let start: string | undefined;
  let startLine = Infinity;
  for (const n of graph.nodes) {
    if (n.uri !== undefined && n.uri === opts.startFileUri && (n.line ?? 0) < startLine) {
      start = n.name.toLowerCase();
      startLine = n.line ?? 0;
    }
  }

  const edges: ViewEdge[] = [];
  for (const e of graph.edges) {
    if (!opts.filter[e.callType]) continue;
    edges.push({
      id: `${e.from}\u0000${e.to}\u0000${e.callType}`,
      source: e.from, target: e.to, callType: e.callType, unresolved: false, sites: e.sites, exprs: [],
    });
  }
  if (opts.filter.unresolved) {
    // One "?" per location, with an edge per call type, keeps the graph
    // readable when a location has several dynamic jumps.
    const byKey = new Map<string, ViewEdge>();
    for (const u of graph.unresolved) {
      if (!opts.filter[u.callType]) continue;
      const key = `${u.from}\u0000${u.callType}`;
      let edge = byKey.get(key);
      if (!edge) {
        edge = { id: `${key}\u0000?`, source: u.from, target: unknownId(u.from), callType: u.callType, unresolved: true, sites: [], exprs: [] };
        byKey.set(key, edge);
        edges.push(edge);
      }
      edge.sites.push(u.site);
      if (!edge.exprs.includes(u.expr)) edge.exprs.push(u.expr);
    }
  }

  const all = new Map<string, ViewNode>();
  for (const n of graph.nodes) {
    const id = n.name.toLowerCase();
    all.set(id, {
      id, label: n.name, kind: n.missing ? 'missing' : 'location', uri: n.uri, line: n.line,
      isStart: id === start, isFocus: false, unreachable: false,
    });
  }
  for (const e of edges) {
    if (e.unresolved && !all.has(e.target)) {
      all.set(e.target, { id: e.target, label: '?', kind: 'unknown', isStart: false, isFocus: false, unreachable: false });
    }
  }

  // Reachability is judged on every call type, not just the ones shown, so
  // hiding `desc` edges doesn't make a location look unreachable.
  const entered = new Set<string>();
  for (const e of graph.edges) if (e.from !== e.to) entered.add(e.to);
  for (const node of all.values()) {
    node.unreachable = node.kind === 'location' && !node.isStart && !entered.has(node.id);
  }

  const focus = opts.focus ?? start;
  const focusMissing = opts.focus !== undefined && !all.has(opts.focus);
  let keep: Set<string>;
  if (opts.depth === 'all' || focus === undefined || !all.has(focus)) {
    keep = new Set(all.keys());
  } else {
    keep = new Set([focus]);
    let frontier = [focus];
    for (let step = 0; step < opts.depth && frontier.length > 0; step++) {
      const next: string[] = [];
      for (const e of edges) {
        for (const [a, b] of [[e.source, e.target], [e.target, e.source]]) {
          if (frontier.includes(a) && !keep.has(b)) {
            keep.add(b);
            next.push(b);
          }
        }
      }
      frontier = next;
    }
  }
  if (focus !== undefined && all.has(focus)) all.get(focus)!.isFocus = true;

  return {
    nodes: [...all.values()].filter(n => keep.has(n.id)),
    edges: edges.filter(e => keep.has(e.source) && keep.has(e.target)),
    focusMissing,
  };
}

// ── Messages between the extension and the webview ───────────────────

/** What the webview keeps across reloads (vscode.setState) and restores with the panel. */
export interface JumpGraphViewState {
  mode: 'around' | 'all';
  depth: number;
  followCursor: boolean;
  filter: EdgeFilter;
  /** Lowercase name of the location last centred on. */
  focus?: string;
}

export type HostToWebview =
  | { type: 'graph'; graph: JumpGraphData; startFileUri?: string; relPaths: Record<string, string> }
  /** The editor's cursor moved into this location (lowercase name), or a command asked to show it. */
  | { type: 'focus'; name: string; force: boolean };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'open'; uri: string; line: number }
  | { type: 'followCursor'; enabled: boolean };
