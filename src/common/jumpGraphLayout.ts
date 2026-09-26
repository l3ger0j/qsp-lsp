// ── Jump graph layout ────────────────────────────────────────────────
//
// Where the Jump Graph webview puts its nodes. Small graphs get the
// layered dagre layout (run by Cytoscape in the webview); dagre takes
// seconds from a few hundred locations and minutes near a thousand, so
// larger ones get a d3-force simulation, run a slice at a time so the
// panel stays responsive. When the view is redrawn after an edit, the
// nodes that were already on screen keep their places.

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Force,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
  /** Id of the compound node drawn around it (an expanded file); nodes of one group are kept together. */
  group?: string;
}

export interface LayoutEdge { source: string; target: string }

export interface Point { x: number; y: number }
export type Positions = Map<string, Point>;

/** Graphs up to this size are laid out in layers; dagre takes ~0.5 s at this size. */
export const LAYERED_MAX_NODES = 80;
export const LAYERED_MAX_EDGES = 250;

/** Pick dagre ('layered') or the force simulation for a graph of this size. */
export function chooseLayout(nodeCount: number, edgeCount: number): 'layered' | 'force' {
  return nodeCount <= LAYERED_MAX_NODES && edgeCount <= LAYERED_MAX_EDGES ? 'layered' : 'force';
}

// Below this share of nodes with a remembered place, the old picture says
// too little about the new graph and a fresh layout reads better.
const MIN_REUSED_SHARE = 0.7;

/**
 * Reuse `cached` positions for `nodes` when most of them have one, and put
 * the rest next to a neighbour (or the node their group is named after) that has. Returns
 * undefined when too few nodes are known. `fresh` lists the nodes placed
 * here for the first time; a short force run then settles them.
 */
export function seedFromCache(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  cached: Positions | undefined,
): { positions: Positions; fresh: string[] } | undefined {
  if (!cached || nodes.length === 0) return undefined;
  const known = nodes.filter(n => cached.has(n.id)).length;
  if (known / nodes.length < MIN_REUSED_SHARE) return undefined;

  const positions: Positions = new Map();
  for (const n of nodes) {
    const p = cached.get(n.id);
    if (p) positions.set(n.id, { ...p });
  }
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = neighbours.get(a);
    if (list) list.push(b); else neighbours.set(a, [b]);
  };
  for (const e of edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }
  let right = -Infinity, top = Infinity;
  for (const p of positions.values()) {
    right = Math.max(right, p.x);
    top = Math.min(top, p.y);
  }

  const fresh: string[] = [];
  let stray = 0;
  for (const n of nodes) {
    if (positions.has(n.id)) continue;
    fresh.push(n.id);
    const anchors = (neighbours.get(n.id) ?? []).map(id => cached.get(id)).filter((p): p is Point => p !== undefined);
    const groupAnchor = n.group === undefined ? undefined : cached.get(n.group);
    if (anchors.length === 0 && groupAnchor) anchors.push(groupAnchor);
    if (anchors.length > 0) {
      // Spread nodes that share an anchor around it instead of stacking them.
      const angle = fresh.length * 2.4;
      positions.set(n.id, {
        x: anchors.reduce((s, p) => s + p.x, 0) / anchors.length + 60 * Math.cos(angle),
        y: anchors.reduce((s, p) => s + p.y, 0) / anchors.length + 60 * Math.sin(angle),
      });
    } else {
      positions.set(n.id, { x: right + 150, y: top + 40 * stray++ });
    }
  }
  return { positions, fresh };
}

/** Ids in `positions` within `radius` of any of `centres`, the centres included. */
export function nodesNear(positions: Positions, centres: Iterable<string>, radius: number): Set<string> {
  const points = [...centres].map(id => positions.get(id)).filter((p): p is Point => p !== undefined);
  const near = new Set<string>();
  for (const [id, p] of positions) {
    if (points.some(c => Math.abs(c.x - p.x) <= radius && Math.abs(c.y - p.y) <= radius)) near.add(id);
  }
  return near;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  radius: number;
  group?: string;
}

// Pulls the nodes of a group (an expanded file) towards their centre.
function forceGroups(strength: number): Force<SimNode, undefined> {
  let nodes: SimNode[] = [];
  const force = (alpha: number) => {
    const centres = new Map<string, { x: number; y: number; n: number }>();
    for (const d of nodes) {
      if (d.group === undefined) continue;
      let c = centres.get(d.group);
      if (!c) centres.set(d.group, c = { x: 0, y: 0, n: 0 });
      c.x += d.x!;
      c.y += d.y!;
      c.n++;
    }
    for (const d of nodes) {
      const c = d.group === undefined ? undefined : centres.get(d.group);
      if (!c) continue;
      d.vx! += (c.x / c.n - d.x!) * strength * alpha;
      d.vy! += (c.y / c.n - d.y!) * strength * alpha;
    }
  };
  force.initialize = (ns: SimNode[]) => { nodes = ns; };
  return force;
}

/** Options for {@link ForceLayout}. */
export interface ForceLayoutOptions {
  /** Starting places; nodes without one start on d3's spiral. */
  seed?: Positions;
  /** Nodes that stay where `seed` puts them. */
  pinned?: ReadonlySet<string>;
}

/**
 * A d3-force simulation that runs in slices. Nodes repel each other,
 * jumps pull locations together, and each node keeps clear of the others
 * by half its width, so labels don't overlap.
 */
export class ForceLayout {
  private readonly sim: Simulation<SimNode, undefined>;
  private readonly nodes: SimNode[];
  private readonly ticks: number;
  private done = 0;

  constructor(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], opts: ForceLayoutOptions = {}) {
    // The grouping force only keeps a group together; groups that start
    // mixed on one spiral stay mixed, so each starts from its own spot.
    const groups = new Map<string, { x: number; y: number; placed: number }>();
    for (const n of nodes) if (n.group !== undefined && !groups.has(n.group)) groups.set(n.group, { x: 0, y: 0, placed: 0 });
    const ring = 40 * Math.sqrt(nodes.length) * (groups.size > 1 ? 1 : 0);
    [...groups.values()].forEach((g, i) => {
      g.x = ring * Math.cos((2 * Math.PI * i) / groups.size);
      g.y = ring * Math.sin((2 * Math.PI * i) / groups.size);
    });

    this.nodes = nodes.map(n => {
      const d: SimNode = { id: n.id, radius: Math.max(n.width, n.height) / 2 + 8, group: n.group };
      const group = n.group === undefined ? undefined : groups.get(n.group);
      if (group) {
        const k = group.placed++;
        d.x = group.x + 20 * Math.sqrt(k) * Math.cos(k * 2.4);
        d.y = group.y + 20 * Math.sqrt(k) * Math.sin(k * 2.4);
      }
      const p = opts.seed?.get(n.id);
      if (p) {
        d.x = p.x;
        d.y = p.y;
        if (opts.pinned?.has(n.id)) {
          d.fx = p.x;
          d.fy = p.y;
        }
      }
      return d;
    });
    const ids = new Set(nodes.map(n => n.id));
    const links: Array<SimulationLinkDatum<SimNode>> = edges
      .filter(e => e.source !== e.target && ids.has(e.source) && ids.has(e.target))
      .map(e => ({ source: e.source, target: e.target }));
    // Settling a few new nodes among pinned ones needs far fewer steps.
    const settling = opts.pinned !== undefined && opts.pinned.size > 0;
    this.ticks = settling ? 80 : 300;

    this.sim = forceSimulation(this.nodes)
      .force('link', forceLink<SimNode, SimulationLinkDatum<SimNode>>(links).id(d => d.id).distance(90).strength(0.3))
      .force('charge', forceManyBody<SimNode>().strength(-300).theta(0.9).distanceMax(1500))
      .force('collide', forceCollide<SimNode>(d => d.radius).iterations(2))
      .force('x', forceX<SimNode>().strength(0.03))
      .force('y', forceY<SimNode>().strength(0.03))
      .force('groups', forceGroups(0.2))
      // d3 starts a timer of its own; the slices below drive the simulation instead.
      .stop();
    if (settling) this.sim.alpha(0.3);
  }

  /** Run steps for about `budgetMs`; true once the layout is finished. */
  step(budgetMs: number): boolean {
    const until = Date.now() + budgetMs;
    while (this.done < this.ticks) {
      this.sim.tick();
      this.done++;
      if (Date.now() >= until) break;
    }
    return this.done >= this.ticks;
  }

  /** Share of the work done, 0 to 1. */
  get progress(): number {
    return this.done / this.ticks;
  }

  /** Where the nodes are now. */
  positions(): Positions {
    return new Map(this.nodes.map(d => [d.id, { x: d.x!, y: d.y! }]));
  }
}
