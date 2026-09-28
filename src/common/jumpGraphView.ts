// ── Jump graph view model ────────────────────────────────────────────
//
// What the Jump Graph webview draws: the server's jump graph filtered by
// call type, with hubs (locations called from almost everywhere) taken
// out, and cut down to the neighbourhood of one location, kept whole, or
// folded into one node per file. The start location, unreachable
// locations and jumps to unknown targets are marked. Pure, shared by the
// webview and the tests.

/** Wire shape of `qsp/jumpGraph` (see src/server/jumpGraph.ts). */
export interface JumpGraphData {
  nodes: Array<{ name: string; uri?: string; line?: number; missing?: boolean }>;
  /** `sites` holds the first few places; `siteCount` counts them all. */
  edges: Array<{ from: string; to: string; callType: CallType; kind: 'exact' | 'possible'; via?: string[]; sites: WireSite[]; siteCount: number }>;
  /** Grouped per location and call type. */
  unresolved: Array<{ from: string; callType: CallType; exprs: string[]; sites: WireSite[]; siteCount: number }>;
}

/** A jump site as sent: `uri` is left out when it's the file of the `from` location. */
export interface WireSite { uri?: string; line: number; text: string }

export type CallType = 'goto' | 'gosub' | 'func' | 'desc';
export interface JumpSite { uri: string; line: number; text: string }

export interface EdgeFilter {
  goto: boolean;
  gosub: boolean;
  func: boolean;
  desc: boolean;
  /** Jumps whose target the analysis can't name, drawn to a "?" node. */
  unresolved: boolean;
  /** Dynamic jumps (`gt $next`) drawn to the locations their variables' known values name. */
  possible: boolean;
}

export const ALL_EDGES: EdgeFilter = { goto: true, gosub: true, func: true, desc: true, unresolved: true, possible: true };

export interface ViewNode {
  id: string;
  label: string;
  kind: 'location' | 'missing' | 'unknown' | 'file';
  uri?: string;
  line?: number;
  isStart: boolean;
  isFocus: boolean;
  /** No other location jumps or calls here, and it isn't the start. */
  unreachable: boolean;
  /** Labels of the hidden hubs this location jumps to or calls. */
  hubCalls?: string[];
  /** A location of an expanded file: that file node's id. */
  parent?: string;
  /** A file node: how many of the shown locations the file holds. */
  locationCount?: number;
  /** A file node whose locations are drawn. */
  expanded?: boolean;
}

export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  /** For an edge that stands for several jumps, the first of `callTypes`. */
  callType: CallType;
  /** Every call type among the jumps this edge stands for. */
  callTypes: CallType[];
  unresolved: boolean;
  /** A dynamic jump that may go here (see `EdgeFilter.possible`); for a merged edge, all its jumps are. */
  possible: boolean;
  /** The first few places the jumps are written. */
  sites: JumpSite[];
  /** How many places in all. */
  siteCount: number;
  /** For an unresolved or possible edge, the target expressions (`$next`, …). */
  exprs: string[];
}

export interface HiddenHub {
  id: string;
  label: string;
  /** How many other locations jump to or call it. */
  callers: number;
}

export interface ViewGraph {
  nodes: ViewNode[];
  edges: ViewEdge[];
  /** The focus asked for isn't in the graph (renamed, deleted, or filtered out). */
  focusMissing: boolean;
  /** Hubs left out of the view, most called first. */
  hiddenHubs: HiddenHub[];
}

export interface ViewOptions {
  /** Lowercase location name to centre on; undefined centres on the start location. */
  focus?: string;
  /** Steps from the focus, in either direction; `'all'` keeps the whole graph. */
  depth: number | 'all';
  filter: EdgeFilter;
  /** The file the game starts from; its first location is the start. */
  startFileUri?: string;
  /**
   * Hide locations that at least this many other locations jump to or
   * call (0 or undefined hides none). The focus of a neighbourhood view
   * is never hidden.
   */
  hubThreshold?: number;
}

const unknownId = (from: string) => `?:${from}`;

// Cytoscape refuses an empty id, and `gt ''` or a header with no name gives
// one; a NUL can't be part of a location name, so this one clashes with none.
const EMPTY_NAME_ID = '\u0000(empty)';

/**
 * Id of the node of a location (or missing target) with this lowercase
 * name. Idempotent, so an id can go through it again.
 */
export const nodeId = (lowerName: string) => (lowerName === '' ? EMPTY_NAME_ID : lowerName);
const labelOf = (name: string) => (name === '' ? "''" : name);

/** Id of the node that stands for a whole file in the by-file view. */
export const fileNodeId = (uri: string) => `file:${uri}`;

/** Cut `graph` down to what the view shows. */
export function buildViewGraph(graph: JumpGraphData, opts: ViewOptions): ViewGraph {
  let start: string | undefined;
  let startLine = Infinity;
  for (const n of graph.nodes) {
    if (n.uri !== undefined && n.uri === opts.startFileUri && (n.line ?? 0) < startLine) {
      start = nodeId(n.name.toLowerCase());
      startLine = n.line ?? 0;
    }
  }
  const focus = opts.focus === undefined ? start : nodeId(opts.focus);

  // Counted over every call type, like reachability below, so a hub stays
  // hidden while the filters change.
  const callers = new Map<string, Set<string>>();
  const edgesIn = graph.edges.map(e => ({ ...e, from: nodeId(e.from), to: nodeId(e.to) }));
  for (const e of edgesIn) {
    if (e.from === e.to) continue;
    let set = callers.get(e.to);
    if (!set) callers.set(e.to, set = new Set());
    set.add(e.from);
  }
  const hubs = new Map<string, HiddenHub>();
  if (opts.hubThreshold) {
    const kept = opts.depth === 'all' ? undefined : focus;
    for (const n of graph.nodes) {
      const id = nodeId(n.name.toLowerCase());
      const count = callers.get(id)?.size ?? 0;
      if (count >= opts.hubThreshold && id !== kept) hubs.set(id, { id, label: labelOf(n.name), callers: count });
    }
  }

  const all = new Map<string, ViewNode>();
  for (const n of graph.nodes) {
    const id = nodeId(n.name.toLowerCase());
    if (hubs.has(id)) continue;
    all.set(id, {
      id, label: labelOf(n.name), kind: n.missing ? 'missing' : 'location', uri: n.uri, line: n.line,
      isStart: id === start, isFocus: false,
      // Reachability is judged on every call type, not just the ones shown,
      // so hiding `desc` edges doesn't make a location look unreachable.
      unreachable: !n.missing && id !== start && !callers.has(id),
    });
  }

  const fileOf = new Map(graph.nodes.map(n => [nodeId(n.name.toLowerCase()), n.uri]));
  const sitesOf = (from: string, sites: WireSite[]): JumpSite[] => {
    const uri = fileOf.get(from) ?? '';
    return sites.map(s => ({ uri: s.uri ?? uri, line: s.line, text: s.text }));
  };

  const edges: ViewEdge[] = [];
  for (const e of edgesIn) {
    const possible = e.kind === 'possible';
    if (!opts.filter[e.callType] || (possible && !opts.filter.possible) || hubs.has(e.from)) continue;
    const hub = hubs.get(e.to);
    if (hub) {
      const from = all.get(e.from);
      if (from) {
        from.hubCalls ??= [];
        if (!from.hubCalls.includes(hub.label)) from.hubCalls.push(hub.label);
      }
      continue;
    }
    edges.push({
      id: `${e.from}\u0000${e.to}\u0000${e.callType}${possible ? '\u0000~' : ''}`,
      source: e.from, target: e.to, callType: e.callType, callTypes: [e.callType], unresolved: false, possible,
      sites: sitesOf(e.from, e.sites), siteCount: e.siteCount, exprs: e.via ?? [],
    });
  }
  if (opts.filter.unresolved) {
    // One "?" per location, with an edge per call type, keeps the graph
    // readable when a location has several dynamic jumps.
    for (const unresolved of graph.unresolved) {
      const u = { ...unresolved, from: nodeId(unresolved.from) };
      if (!opts.filter[u.callType] || hubs.has(u.from)) continue;
      const target = unknownId(u.from);
      edges.push({
        id: `${u.from}\u0000${u.callType}\u0000?`, source: u.from, target,
        callType: u.callType, callTypes: [u.callType], unresolved: true, possible: false, sites: sitesOf(u.from, u.sites), siteCount: u.siteCount, exprs: u.exprs,
      });
      if (!all.has(target)) {
        all.set(target, { id: target, label: '?', kind: 'unknown', isStart: false, isFocus: false, unreachable: false });
      }
    }
  }

  const focusMissing = opts.focus !== undefined && !all.has(focus!);
  let keep: Set<string>;
  if (opts.depth === 'all' || focus === undefined || !all.has(focus)) {
    keep = new Set(all.keys());
  } else {
    const neighbours = new Map<string, string[]>();
    const link = (a: string, b: string) => {
      const list = neighbours.get(a);
      if (list) list.push(b); else neighbours.set(a, [b]);
    };
    for (const e of edges) {
      link(e.source, e.target);
      link(e.target, e.source);
    }
    keep = new Set([focus]);
    let frontier = [focus];
    for (let step = 0; step < opts.depth && frontier.length > 0; step++) {
      const next: string[] = [];
      for (const a of frontier) {
        for (const b of neighbours.get(a) ?? []) {
          if (!keep.has(b)) {
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
    hiddenHubs: [...hubs.values()].sort((a, b) => b.callers - a.callers || a.label.localeCompare(b.label)),
  };
}

/**
 * Fold `view` into one node per file, except the files in `expanded`,
 * whose locations stay and get the file node's id in `parent`. Jumps
 * between the same two nodes become one edge; jumps inside a folded file
 * are dropped.
 */
export function foldByFile(view: ViewGraph, expanded: ReadonlySet<string>): ViewGraph {
  const rep = new Map<string, string>();
  const files = new Map<string, ViewNode>();
  const folded = new Set<string>();
  const nodes: ViewNode[] = [];
  for (const n of view.nodes) {
    if (n.kind === 'location' && n.uri !== undefined) {
      let file = files.get(n.uri);
      if (!file) {
        file = {
          id: fileNodeId(n.uri), label: decodeURIComponent(n.uri.slice(n.uri.lastIndexOf('/') + 1)), kind: 'file', uri: n.uri,
          isStart: false, isFocus: false, unreachable: false, locationCount: 0, expanded: expanded.has(n.uri),
        };
        files.set(n.uri, file);
        nodes.push(file);
      }
      file.locationCount!++;
      if (file.expanded) {
        nodes.push({ ...n, parent: file.id });
        rep.set(n.id, n.id);
      } else {
        if (n.isStart) file.isStart = true;
        folded.add(file.id);
        rep.set(n.id, file.id);
      }
    } else if (n.kind === 'missing') {
      nodes.push(n);
      rep.set(n.id, n.id);
    }
    // "?" nodes are made again below, one per folded source.
  }

  const edges = new Map<string, ViewEdge>();
  const unknown = new Set<string>();
  for (const e of view.edges) {
    const source = rep.get(e.source);
    if (source === undefined) continue;
    const target = e.unresolved ? unknownId(source) : rep.get(e.target);
    if (target === undefined || (source === target && folded.has(source))) continue;
    const key = `${source}\u0000${target}`;
    let edge = edges.get(key);
    if (!edge) {
      edge = { id: key, source, target, callType: e.callType, callTypes: [], unresolved: e.unresolved, possible: e.possible, sites: [], siteCount: 0, exprs: [] };
      edges.set(key, edge);
      if (e.unresolved && !unknown.has(target)) {
        unknown.add(target);
        nodes.push({ id: target, label: '?', kind: 'unknown', isStart: false, isFocus: false, unreachable: false });
      }
    }
    for (const t of e.callTypes) if (!edge.callTypes.includes(t)) edge.callTypes.push(t);
    edge.possible &&= e.possible;
    // A few examples are enough for the tooltip and the click.
    if (edge.sites.length < 3) edge.sites.push(...e.sites.slice(0, 3 - edge.sites.length));
    edge.siteCount += e.siteCount;
    for (const x of e.exprs) if (!edge.exprs.includes(x)) edge.exprs.push(x);
  }
  return { nodes, edges: [...edges.values()], focusMissing: false, hiddenHubs: view.hiddenHubs };
}

// ── Messages between the extension and the webview ───────────────────

/** What the webview keeps across reloads (vscode.setState) and restores with the panel. */
export interface JumpGraphViewState {
  mode: 'around' | 'all' | 'files';
  depth: number;
  followCursor: boolean;
  filter: EdgeFilter;
  /** Lowercase name of the location last centred on. */
  focus?: string;
  /** See `ViewOptions.hubThreshold`. */
  hubThreshold: number;
  /** Files drawn open in the by-file view. */
  expandedFiles: string[];
}

export type HostToWebview =
  | { type: 'graph'; graph: JumpGraphData; startFileUri?: string; relPaths: Record<string, string> }
  /** The editor's cursor moved into this location (lowercase name), or a command asked to show it. */
  | { type: 'focus'; name: string; force: boolean };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'open'; uri: string; line: number }
  | { type: 'followCursor'; enabled: boolean }
  /** A line for the language server's output channel (layout timings). */
  | { type: 'log'; message: string };
