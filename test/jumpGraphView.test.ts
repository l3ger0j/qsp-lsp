import { describe, it, expect } from 'vitest';
import { ALL_EDGES, buildViewGraph, fileNodeId, foldByFile, nodeId, type JumpGraphData } from '../src/common/jumpGraphView';

const M = 'file:///g/main.qsps';
const site = (line: number) => ({ uri: M, line, text: 'x' });

// start -> hall -> kitchen -> cellar ; hall -gosub-> util ; kitchen -> hall (cycle)
// orphan: nobody jumps here ; start -> ? via $next ; hall -> missing 'attic'
const graph: JumpGraphData = {
  nodes: [
    { name: 'Start', uri: M, line: 0 },
    { name: 'Hall', uri: M, line: 5 },
    { name: 'kitchen', uri: M, line: 10 },
    { name: 'cellar', uri: M, line: 15 },
    { name: 'util', uri: 'file:///g/lib.qsps', line: 0 },
    { name: 'orphan', uri: M, line: 20 },
    { name: 'attic', missing: true },
  ],
  edges: [
    { from: 'start', to: 'hall', callType: 'goto', kind: 'exact', siteCount: 1, sites: [site(1)] },
    { from: 'hall', to: 'kitchen', callType: 'goto', kind: 'exact', siteCount: 1, sites: [site(6)] },
    { from: 'kitchen', to: 'cellar', callType: 'goto', kind: 'exact', siteCount: 1, sites: [site(11)] },
    { from: 'kitchen', to: 'hall', callType: 'goto', kind: 'exact', siteCount: 1, sites: [site(12)] },
    { from: 'hall', to: 'util', callType: 'gosub', kind: 'exact', siteCount: 1, sites: [site(7)] },
    { from: 'hall', to: 'attic', callType: 'goto', kind: 'exact', siteCount: 1, sites: [site(8)] },
  ],
  unresolved: [
    { from: 'start', callType: 'goto', exprs: ['$next', '$other'], sites: [site(2), site(3)], siteCount: 2 },
  ],
};

const ids = (g: ReturnType<typeof buildViewGraph>) => g.nodes.map(n => n.id).sort();

describe('buildViewGraph', () => {
  it('centres on the start location by default and follows edges both ways', () => {
    const g = buildViewGraph(graph, { depth: 1, filter: ALL_EDGES, startFileUri: M });
    expect(ids(g)).toEqual(['?:start', 'hall', 'start']);
    expect(g.nodes.find(n => n.id === 'start')).toMatchObject({ isStart: true, isFocus: true, label: 'Start' });
  });

  it('goes further with a larger depth, through cycles without repeating', () => {
    const g = buildViewGraph(graph, { focus: 'kitchen', depth: 2, filter: ALL_EDGES, startFileUri: M });
    expect(ids(g)).toEqual(['attic', 'cellar', 'hall', 'kitchen', 'start', 'util']);
    expect(g.edges.filter(e => e.source === 'kitchen').map(e => e.target).sort()).toEqual(['cellar', 'hall']);
  });

  it('keeps everything with depth "all" and marks unreachable locations', () => {
    const g = buildViewGraph(graph, { depth: 'all', filter: ALL_EDGES, startFileUri: M });
    expect(g.nodes).toHaveLength(8);
    expect(g.nodes.filter(n => n.unreachable).map(n => n.id)).toEqual(['orphan']);
    expect(g.nodes.find(n => n.id === 'attic')!.kind).toBe('missing');
  });

  it('draws a location\'s unknown targets as one "?" edge per call type', () => {
    const g = buildViewGraph(graph, { depth: 'all', filter: ALL_EDGES, startFileUri: M });
    const q = g.edges.filter(e => e.unresolved);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ source: 'start', target: '?:start', exprs: ['$next', '$other'] });
    expect(q[0].siteCount).toBe(2);
  });

  it('fills in the file of a site from the location it is in', () => {
    const wire: JumpGraphData = {
      nodes: [{ name: 'a', uri: M, line: 0 }, { name: 'b', uri: M, line: 5 }],
      edges: [{ from: 'a', to: 'b', callType: 'goto', kind: 'exact', siteCount: 2, sites: [{ line: 1, text: 'x' }, { uri: 'file:///g/other.qsps', line: 3, text: 'y' }] }],
      unresolved: [],
    };
    const g = buildViewGraph(wire, { depth: 'all', filter: ALL_EDGES, startFileUri: M });
    expect(g.edges[0].sites.map(x => x.uri)).toEqual([M, 'file:///g/other.qsps']);
  });

  it('filters by call type, but judges reachability on every edge', () => {
    const g = buildViewGraph(graph, { depth: 'all', filter: { ...ALL_EDGES, gosub: false, unresolved: false }, startFileUri: M });
    expect(g.edges.some(e => e.callType === 'gosub' || e.unresolved)).toBe(false);
    expect(g.nodes.find(n => n.id === 'util')!.unreachable).toBe(false);
    expect(g.nodes.some(n => n.kind === 'unknown')).toBe(false);
  });

  it('shows everything and reports it when the focus is gone', () => {
    const g = buildViewGraph(graph, { focus: 'renamed', depth: 1, filter: ALL_EDGES, startFileUri: M });
    expect(g.focusMissing).toBe(true);
    expect(g.nodes).toHaveLength(8);
  });

  it('hides hubs, marks their callers, and doesn\'t pass through them', () => {
    // hall is entered from start and kitchen.
    const g = buildViewGraph(graph, { focus: 'start', depth: 3, filter: ALL_EDGES, startFileUri: M, hubThreshold: 2 });
    expect(g.hiddenHubs).toEqual([{ id: 'hall', label: 'Hall', callers: 2 }]);
    expect(ids(g)).toEqual(['?:start', 'start']);
    expect(g.nodes.find(n => n.id === 'start')!.hubCalls).toEqual(['Hall']);
  });

  it('keeps a hub that is the focus, and judges reachability with hubs included', () => {
    const g = buildViewGraph(graph, { focus: 'hall', depth: 1, filter: ALL_EDGES, startFileUri: M, hubThreshold: 2 });
    expect(g.hiddenHubs).toEqual([]);
    expect(g.nodes.find(n => n.id === 'hall')!.isFocus).toBe(true);

    const all = buildViewGraph(graph, { depth: 'all', filter: ALL_EDGES, startFileUri: M, hubThreshold: 2 });
    expect(all.nodes.find(n => n.id === 'kitchen')!.unreachable).toBe(false);
  });

  it('hides the start location too when it is a hub and the whole graph is shown', () => {
    const hubStart: JumpGraphData = {
      nodes: [{ name: 'start', uri: M, line: 0 }, { name: 'a', uri: M, line: 5 }, { name: 'b', uri: M, line: 9 }],
      edges: [
        { from: 'a', to: 'start', callType: 'gosub', kind: 'exact', siteCount: 1, sites: [site(6)] },
        { from: 'b', to: 'start', callType: 'gosub', kind: 'exact', siteCount: 1, sites: [site(10)] },
      ],
      unresolved: [],
    };
    const all = buildViewGraph(hubStart, { depth: 'all', filter: ALL_EDGES, startFileUri: M, hubThreshold: 2 });
    expect(all.hiddenHubs.map(h => h.id)).toEqual(['start']);
    const around = buildViewGraph(hubStart, { depth: 1, filter: ALL_EDGES, startFileUri: M, hubThreshold: 2 });
    expect(around.hiddenHubs).toEqual([]);
  });

  it('hides no hubs with a zero threshold', () => {
    const g = buildViewGraph(graph, { depth: 'all', filter: ALL_EDGES, startFileUri: M, hubThreshold: 0 });
    expect(g.hiddenHubs).toEqual([]);
    expect(g.nodes).toHaveLength(8);
  });

  it('gives a location with an empty name (`gt \'\'`, a bare `#` header) an id Cytoscape accepts', () => {
    const empty: JumpGraphData = {
      nodes: [{ name: 'Start', uri: M, line: 0 }, { name: '', uri: M, line: 5 }],
      edges: [
        { from: 'start', to: '', callType: 'goto', kind: 'exact', siteCount: 1, sites: [site(1)] },
        { from: '', to: 'start', callType: 'goto', kind: 'exact', siteCount: 1, sites: [site(6)] },
      ],
      unresolved: [{ from: '', callType: 'goto', exprs: ['$x'], sites: [site(7)], siteCount: 1 }],
    };
    for (const focus of [undefined, '']) {
      const g = buildViewGraph(empty, { focus, depth: focus === undefined ? 'all' : 1, filter: ALL_EDGES, startFileUri: M });
      expect(g.focusMissing).toBe(false);
      expect(g.nodes).toHaveLength(3);
      for (const x of [...g.nodes.map(n => n.id), ...g.edges.flatMap(e => [e.id, e.source, e.target])]) expect(x).not.toBe('');
      expect(g.nodes.find(n => n.id === nodeId(''))).toMatchObject({ label: "''", isFocus: focus === '' });
      const folded = foldByFile(g, new Set());
      for (const e of folded.edges) expect([e.source, e.target]).not.toContain('');
    }
    expect(nodeId(nodeId(''))).toBe(nodeId(''));
  });
});

describe('foldByFile', () => {
  const L = 'file:///g/lib.qsps';
  const view = buildViewGraph(graph, { depth: 'all', filter: ALL_EDGES, startFileUri: M });

  it('draws one node per file and one counted edge per pair of nodes', () => {
    const g = foldByFile(view, new Set());
    expect(ids(g)).toEqual(['?:file:' + M, 'attic', fileNodeId(L), fileNodeId(M)].sort());
    expect(g.nodes.find(n => n.id === fileNodeId(M))).toMatchObject({ kind: 'file', label: 'main.qsps', locationCount: 5, isStart: true });
    expect(g.nodes.find(n => n.id === fileNodeId(L))!.locationCount).toBe(1);
    // Jumps inside main.qsps are gone; hall -> util and hall -> attic stay.
    const edges = g.edges.map(e => `${e.source} -> ${e.target} ${e.siteCount}`).sort();
    expect(edges).toEqual([
      `${fileNodeId(M)} -> ?:${fileNodeId(M)} 2`,
      `${fileNodeId(M)} -> attic 1`,
      `${fileNodeId(M)} -> ${fileNodeId(L)} 1`,
    ].sort());
  });

  it('keeps the locations of an expanded file inside its node', () => {
    const g = foldByFile(view, new Set([M]));
    const hall = g.nodes.find(n => n.id === 'hall')!;
    expect(hall.parent).toBe(fileNodeId(M));
    expect(g.nodes.find(n => n.id === fileNodeId(M))).toMatchObject({ expanded: true, isStart: false });
    expect(g.edges.find(e => e.source === 'hall' && e.target === fileNodeId(L))).toMatchObject({ callTypes: ['gosub'] });
    expect(g.edges.find(e => e.source === 'kitchen' && e.target === 'hall')).toBeDefined();
    expect(g.nodes.some(n => n.id === '?:start')).toBe(true);
  });

  it('merges call types on a shared edge', () => {
    const two: JumpGraphData = {
      nodes: [{ name: 'a', uri: M, line: 0 }, { name: 'b', uri: L, line: 0 }, { name: 'c', uri: L, line: 3 }],
      edges: [
        { from: 'a', to: 'b', callType: 'goto', kind: 'exact', siteCount: 1, sites: [site(1)] },
        { from: 'a', to: 'c', callType: 'gosub', kind: 'exact', siteCount: 1, sites: [site(2)] },
      ],
      unresolved: [],
    };
    const g = foldByFile(buildViewGraph(two, { depth: 'all', filter: ALL_EDGES, startFileUri: M }), new Set());
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ callTypes: ['goto', 'gosub'], siteCount: 2 });
    expect(g.edges[0].sites).toHaveLength(2);
  });
});
