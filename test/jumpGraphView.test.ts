import { describe, it, expect } from 'vitest';
import { ALL_EDGES, buildViewGraph, type JumpGraphData } from '../src/common/jumpGraphView';

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
    { from: 'start', to: 'hall', callType: 'goto', kind: 'exact', sites: [site(1)] },
    { from: 'hall', to: 'kitchen', callType: 'goto', kind: 'exact', sites: [site(6)] },
    { from: 'kitchen', to: 'cellar', callType: 'goto', kind: 'exact', sites: [site(11)] },
    { from: 'kitchen', to: 'hall', callType: 'goto', kind: 'exact', sites: [site(12)] },
    { from: 'hall', to: 'util', callType: 'gosub', kind: 'exact', sites: [site(7)] },
    { from: 'hall', to: 'attic', callType: 'goto', kind: 'exact', sites: [site(8)] },
  ],
  unresolved: [
    { from: 'start', callType: 'goto', expr: '$next', site: site(2) },
    { from: 'start', callType: 'goto', expr: '$other', site: site(3) },
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

  it('groups a location\'s unknown targets into one "?" edge per call type', () => {
    const g = buildViewGraph(graph, { depth: 'all', filter: ALL_EDGES, startFileUri: M });
    const q = g.edges.filter(e => e.unresolved);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ source: 'start', target: '?:start', exprs: ['$next', '$other'] });
    expect(q[0].sites).toHaveLength(2);
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
});
