import { describe, it, expect } from 'vitest';
import { chooseLayout, ForceLayout, nodesNear, seedFromCache, type LayoutNode, type Positions } from '../src/common/jumpGraphLayout';

const node = (id: string, group?: string): LayoutNode => ({ id, width: 80, height: 24, group });

// A ring of `n` locations with a shortcut every tenth one.
function ring(n: number) {
  const nodes = Array.from({ length: n }, (_, i) => node(`n${i}`));
  const edges = nodes.flatMap((_, i) => [
    { source: `n${i}`, target: `n${(i + 1) % n}` },
    ...(i % 10 === 0 ? [{ source: `n${i}`, target: `n${(i + n / 2) % n}` }] : []),
  ]);
  return { nodes, edges };
}

function overlaps(nodes: LayoutNode[], at: Positions): number {
  let count = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = at.get(nodes[i].id)!, b = at.get(nodes[j].id)!;
      if (Math.abs(a.x - b.x) < 80 && Math.abs(a.y - b.y) < 24) count++;
    }
  }
  return count;
}

describe('chooseLayout', () => {
  it('lays out small graphs in layers and large ones by force', () => {
    expect(chooseLayout(40, 100)).toBe('layered');
    expect(chooseLayout(80, 250)).toBe('layered');
    expect(chooseLayout(81, 100)).toBe('force');
    expect(chooseLayout(60, 400)).toBe('force');
  });
});

describe('ForceLayout', () => {
  it('runs in slices and places every node without overlaps', () => {
    const { nodes, edges } = ring(200);
    const layout = new ForceLayout(nodes, edges);
    expect(layout.step(0)).toBe(false);
    expect(layout.progress).toBeGreaterThan(0);
    while (!layout.step(50)) { /* until done */ }
    expect(layout.progress).toBe(1);
    const at = layout.positions();
    expect([...at.values()].every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(overlaps(nodes, at)).toBe(0);
  });

  it('keeps pinned nodes where they were', () => {
    const { nodes, edges } = ring(30);
    const seed: Positions = new Map(nodes.map((n, i) => [n.id, { x: i * 100, y: 0 }]));
    const layout = new ForceLayout(nodes, edges, { seed, pinned: new Set(nodes.slice(1).map(n => n.id)) });
    while (!layout.step(50)) { /* until done */ }
    const at = layout.positions();
    expect(at.get('n5')).toEqual({ x: 500, y: 0 });
    expect(at.get('n0')).not.toEqual({ x: 0, y: 0 });
  });

  it('keeps the locations of one file together', () => {
    const nodes = [...Array.from({ length: 20 }, (_, i) => node(`a${i}`, 'A')), ...Array.from({ length: 20 }, (_, i) => node(`b${i}`, 'B'))];
    // Every jump crosses files, so only the grouping holds a file together.
    const edges = Array.from({ length: 20 }, (_, i) => ({ source: `a${i}`, target: `b${(i * 7) % 20}` }));
    const layout = new ForceLayout(nodes, edges);
    while (!layout.step(50)) { /* until done */ }
    const at = layout.positions();
    const centre = (prefix: string) => {
      const ps = nodes.filter(n => n.id.startsWith(prefix)).map(n => at.get(n.id)!);
      return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
    };
    const spread = (prefix: string) => {
      const c = centre(prefix);
      return nodes.filter(n => n.id.startsWith(prefix)).reduce((s, n) => s + Math.hypot(at.get(n.id)!.x - c.x, at.get(n.id)!.y - c.y), 0) / 20;
    };
    const a = centre('a'), b = centre('b');
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(Math.min(spread('a'), spread('b')) / 2);
  });
});

describe('seedFromCache', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d')];
  const edges = [{ source: 'a', target: 'd' }, { source: 'b', target: 'd' }];

  it('reuses remembered places and puts a new node next to its neighbours', () => {
    const cached: Positions = new Map([['a', { x: 0, y: 0 }], ['b', { x: 200, y: 0 }], ['c', { x: 0, y: 300 }]]);
    const seeded = seedFromCache(nodes, edges, cached)!;
    expect(seeded.fresh).toEqual(['d']);
    expect(seeded.positions.get('a')).toEqual({ x: 0, y: 0 });
    const d = seeded.positions.get('d')!;
    expect(Math.hypot(d.x - 100, d.y)).toBeLessThanOrEqual(61);
  });

  it('starts over when too few nodes are known', () => {
    expect(seedFromCache(nodes, edges, new Map([['a', { x: 0, y: 0 }]]))).toBeUndefined();
    expect(seedFromCache(nodes, edges, undefined)).toBeUndefined();
  });

  it('puts a new node without placed neighbours next to the node its group is named after, or beside the graph', () => {
    const withParent = [node('a'), node('b'), node('c'), node('x', 'F'), node('y')];
    const cached: Positions = new Map([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }], ['c', { x: 200, y: 50 }], ['F', { x: 1000, y: 1000 }]]);
    const seeded = seedFromCache(withParent, [], cached);
    // 3 of 5 known is under the 70% needed.
    expect(seeded).toBeUndefined();
    cached.set('y', { x: 0, y: 100 });
    const again = seedFromCache(withParent, [], cached)!;
    const x = again.positions.get('x')!;
    expect(Math.hypot(x.x - 1000, x.y - 1000)).toBeLessThanOrEqual(61);

    const lone = seedFromCache([...withParent.slice(0, 4).map(n => ({ ...n, group: undefined })), node('y')], [], cached)!;
    expect(lone.positions.get('x')!.x).toBeGreaterThan(200);
  });
});

describe('nodesNear', () => {
  it('finds the nodes around the given ones', () => {
    const at: Positions = new Map([['a', { x: 0, y: 0 }], ['b', { x: 300, y: 0 }], ['c', { x: 1000, y: 0 }], ['d', { x: 0, y: -350 }]]);
    expect([...nodesNear(at, ['a'], 400)].sort()).toEqual(['a', 'b', 'd']);
    expect([...nodesNear(at, ['c', 'missing'], 100)]).toEqual(['c']);
  });
});
