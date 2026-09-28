// ── Jump graph ───────────────────────────────────────────────────────
//
// Which location jumps to or calls which, built from the symbols the
// analysis already has: `locationRefs` for literal targets, and
// `dynamicLocationRefs` for targets that are expressions. Those become
// "possible" edges to the locations their variables' known values name
// (`gt $next` after `$next = 'hall'`, `gt 'room_' + n`), and stay
// unresolved when nothing, or not everything, is known. Served to the
// client as `qsp/jumpGraph` and drawn by the Jump Graph webview.

import type { DocumentSymbols, LocationEntry } from '../parser';
import { TargetResolver, WILDCARD, wildcardMatcher, type VariableSummary } from '../parser/targetResolver';
import type { TargetPattern } from '../parser/targetPattern';

export type JumpCallType = 'goto' | 'gosub' | 'func' | 'desc';

export interface JumpNode {
  /** Location name as written in its header. */
  name: string;
  /** Absent for a target no file defines (`missing`). */
  uri?: string;
  /** Header line, 0-based. */
  line?: number;
  /** Referenced by a jump or call but not defined anywhere in scope. */
  missing?: boolean;
}

/** One place in the source a jump is written. Lines are 0-based. */
export interface JumpSite {
  /** Left out when it's the file of the location the jump is in, which it nearly always is. */
  uri?: string;
  line: number;
  text: string;
}

export interface JumpEdge {
  /** Lowercase names, matching `JumpNode.name.toLowerCase()`. */
  from: string;
  to: string;
  callType: JumpCallType;
  /** `possible`: a dynamic jump that may go here, given the values its target's variables are known to take. */
  kind: 'exact' | 'possible';
  /** For a possible edge, the target expressions that lead here (`$next`, …), the first `MAX_EXPRS`. */
  via?: string[];
  /** The first few places the jump is written (see `MAX_SITES`), in file and line order. */
  sites: JumpSite[];
  /** How many places in all. */
  siteCount: number;
}

/** The jumps of one call type from one location whose target the analysis can't name. */
export interface UnresolvedJump {
  from: string;
  callType: JumpCallType;
  /** The distinct target expressions (`$next`, …), the first `MAX_EXPRS` of them. */
  exprs: string[];
  sites: JumpSite[];
  siteCount: number;
}

export interface JumpGraph {
  nodes: JumpNode[];
  edges: JumpEdge[];
  unresolved: UnresolvedJump[];
}

/**
 * How the dynamic jumps of a graph fared, for the server log: counts and
 * reasons only (see targetResolver.ts), never a game name.
 */
export interface DynamicJumpStats {
  jumps: number;
  /** Every possible target known. */
  resolved: number;
  /** Some targets known, not all. */
  partly: number;
  unknown: number;
  /** Jumps not resolved in full, per reason (a jump may have several). */
  reasons: Map<string, number>;
  /** Jumps not resolved in full, per form of their target (`$var`, `text + $var`, …; see `patternForm`). */
  forms: Map<string, number>;
  /** The variables those jumps read directly, with how many read each. */
  variables: Map<string, { jumps: number; summary: VariableSummary }>;
}

export interface JumpGraphSource {
  uri: string;
  symbols: DocumentSymbols;
  locationIndex: LocationEntry[];
}

// A game of ~1000 locations has tens of thousands of jump sites. Listing
// them all made each reply tens of megabytes; the graph only shows a few
// per arrow and opens the first.
const MAX_SITES = 3;
const MAX_EXPRS = 10;
const MAX_TEXT = 120;
// A dynamic jump whose target could be more locations than this is
// better shown as unknown than as a fan of guesses.
const MAX_POSSIBLE_TARGETS = 20;

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

function site(uri: string, fromUri: string | undefined, line: number, text: string): JumpSite {
  return uri === fromUri ? { line, text: clip(text) } : { uri, line, text: clip(text) };
}

// Sites arrive in source order per file, but files and merged per-location
// parses interleave, so keep the earliest few rather than the first seen.
function addSite(sites: JumpSite[], s: JumpSite): void {
  const before = (a: JumpSite, b: JumpSite) => {
    const au = a.uri ?? '', bu = b.uri ?? '';
    return au < bu || (au === bu && a.line < b.line);
  };
  if (sites.length === MAX_SITES && !before(s, sites[MAX_SITES - 1])) return;
  let i = sites.length;
  while (i > 0 && before(s, sites[i - 1])) i--;
  sites.splice(i, 0, s);
  if (sites.length > MAX_SITES) sites.pop();
}

/**
 * Build the jump graph of `sources` (every project file, or one file).
 * Edges are grouped per (from, to, call type), unresolved jumps per
 * (from, call type), each with its first few sites and a count.
 * A location defined twice is one node, placed at its first definition,
 * as QSP names are unique per game.
 */
export function buildJumpGraph(sources: Iterable<JumpGraphSource>, stats?: DynamicJumpStats): JumpGraph {
  const nodes = new Map<string, JumpNode>();
  const docs: JumpGraphSource[] = [];
  for (const src of sources) {
    docs.push(src);
    for (const loc of src.locationIndex) {
      if (!nodes.has(loc.nameLower)) nodes.set(loc.nameLower, { name: loc.name, uri: src.uri, line: loc.startLine });
    }
  }

  const edges = new Map<string, JumpEdge>();
  const unresolved = new Map<string, UnresolvedJump>();
  const resolver = new TargetResolver(docs.map(d => d.symbols));
  const possible = new PossibleTargets(nodes);
  for (const { symbols } of docs) {
    for (const locSyms of symbols.locations.values()) {
      const from = locSyms.locationName.toLowerCase();
      const fromUri = nodes.get(from)?.uri;
      for (const [to, target] of locSyms.locationRefs) {
        for (const ref of target.references) {
          // `loc 'name'` (does it exist?) is a location ref with no call type: not a jump.
          if (!ref.callType) continue;
          if (!nodes.has(to)) nodes.set(to, { name: target.name, missing: true });
          const key = `${from}\u0000${to}\u0000${ref.callType}`;
          let edge = edges.get(key);
          if (!edge) {
            edge = { from, to, callType: ref.callType, kind: 'exact', sites: [], siteCount: 0 };
            edges.set(key, edge);
          }
          edge.siteCount++;
          addSite(edge.sites, site(ref.uri, fromUri, ref.line, ref.callText ?? ''));
        }
      }
      for (const d of locSyms.dynamicLocationRefs) {
        if (!d.loc.callType) continue;
        const callType = d.loc.callType;
        const jumpSite = site(d.loc.uri, fromUri, d.loc.line, d.loc.callText ?? d.exprText);
        let complete = false;
        let found = 0;
        const reasons = new Set<string>();
        if (d.target) {
          const r = resolver.resolve(d.target, locSyms, { line: d.loc.line, column: d.loc.column, indent: d.callColumn });
          const targets = possible.of(r.values);
          complete = r.complete && targets.complete && targets.names.length > 0;
          found = targets.names.length;
          for (const x of r.reasons) reasons.add(x);
          for (const x of targets.reasons) reasons.add(x);
          // Known strings, none of them a location: `$next = ''`, a typo, or not a jump target at all.
          if (targets.names.length === 0 && r.values.some(v => !v.includes(WILDCARD))) reasons.add('values name no location');
          for (const to of targets.names) {
            // `gt $curloc`: resolved, but a loop on the location adds nothing to the picture.
            if (to === from) continue;
            const key = `${from}\u0000${to}\u0000${callType}\u0000?`;
            let edge = edges.get(key);
            if (!edge) {
              edge = { from, to, callType, kind: 'possible', via: [], sites: [], siteCount: 0 };
              edges.set(key, edge);
            }
            edge.siteCount++;
            const expr = clip(d.exprText);
            if (edge.via!.length < MAX_EXPRS && !edge.via!.includes(expr)) edge.via!.push(expr);
            addSite(edge.sites, jumpSite);
          }
        }
        if (stats) {
          stats.jumps++;
          if (complete) stats.resolved++;
          else if (found > 0) stats.partly++;
          else stats.unknown++;
          if (!complete) {
            for (const x of reasons) stats.reasons.set(x, (stats.reasons.get(x) ?? 0) + 1);
            const form = d.target ? patternForm(d.target) : 'unknown';
            stats.forms.set(form, (stats.forms.get(form) ?? 0) + 1);
            for (const part of d.target ?? []) {
              if (!('var' in part) || part.var === 'curloc') continue;
              const summary = resolver.describe(part.var, part.index, locSyms);
              const entry = stats.variables.get(summary.key);
              if (entry) entry.jumps++;
              else stats.variables.set(summary.key, { jumps: 1, summary });
            }
          }
        }
        // Known in full: the possible edges say all there is.
        if (complete) continue;
        const key = `${from}\u0000${callType}`;
        let group = unresolved.get(key);
        if (!group) {
          group = { from, callType: d.loc.callType, exprs: [], sites: [], siteCount: 0 };
          unresolved.set(key, group);
        }
        group.siteCount++;
        if (group.exprs.length < MAX_EXPRS) {
          const expr = clip(d.exprText);
          if (!group.exprs.includes(expr)) group.exprs.push(expr);
        }
        addSite(group.sites, jumpSite);
      }
    }
  }

  // A possible edge next to an exact one of the same kind adds nothing.
  for (const [key, e] of edges) {
    if (e.kind === 'possible' && edges.has(`${e.from}\u0000${e.to}\u0000${e.callType}`)) edges.delete(key);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], unresolved: [...unresolved.values()] };
}

/**
 * The shape of a target, for statistics: `text` for literal pieces,
 * `$var`, `$args[0]`, `$curloc`, `func()`, `iif(…)`, and the reason for an
 * unknown piece. No names.
 */
export function patternForm(pattern: TargetPattern): string {
  const form = pattern.map(p => {
    if ('lit' in p) return 'text';
    if ('var' in p) return p.var === 'args' ? `$args[${p.index ?? 0}]` : p.var === 'curloc' ? '$curloc' : '$var';
    if ('result' in p) return 'func()';
    if ('any' in p) return p.why ?? 'unknown';
    return `iif(${p.alt.map(patternForm).join(' | ')})`;
  }).join(' + ');
  return form.length > 60 ? `${form.slice(0, 59)}…` : form;
}

const MAX_LOGGED = 6;

/**
 * One log line for `stats`, each list most frequent first; undefined when
 * there are no dynamic jumps. Variables go by number (v1, v2, …).
 */
export function formatDynamicJumpStats(stats: DynamicJumpStats): string | undefined {
  if (stats.jumps === 0) return undefined;
  const top = <T>(m: Map<string, T>, count: (t: T) => number) =>
    [...m].sort((a, b) => count(b[1]) - count(a[1]) || a[0].localeCompare(b[0])).slice(0, MAX_LOGGED);
  const more = (m: Map<string, unknown>) => (m.size > MAX_LOGGED ? `, +${m.size - MAX_LOGGED} more` : '');
  const forms = top(stats.forms, n => n).map(([f, n]) => `${f} ${n}`);
  const variables = top(stats.variables, v => v.jumps).map(([, v], i) => {
    const s = v.summary;
    const values = `${s.values}${s.complete ? '' : '+'} values`;
    return `v${i + 1} ${v.jumps} jumps (${s.writes} writes, ${values}${s.fromCurloc ? ', some from $curloc' : ''})`;
  });
  const reasons = top(stats.reasons, n => n).map(([r, n]) => `${r} ${n}`);
  let line = `[jump graph] ${stats.jumps} dynamic jumps: ${stats.resolved} resolved, ${stats.partly} in part, ${stats.unknown} unknown`;
  if (forms.length > 0) line += ` · unresolved targets: ${forms.join(', ')}${more(stats.forms)}`;
  if (variables.length > 0) line += ` · variables they read: ${variables.join(', ')}${more(stats.variables)}`;
  if (reasons.length > 0) line += ` · reasons: ${reasons.join(', ')}${more(stats.reasons)}`;
  return line;
}

/** Empty statistics to pass to {@link buildJumpGraph}. */
export function newDynamicJumpStats(): DynamicJumpStats {
  return { jumps: 0, resolved: 0, partly: 0, unknown: 0, reasons: new Map(), forms: new Map(), variables: new Map() };
}

// The defined locations resolved target strings name, with the location
// lists of wildcard strings cached: many jumps share a pattern.
class PossibleTargets {
  private readonly defined: string[];
  private readonly matches = new Map<string, string[] | 'all' | 'too many'>();

  constructor(private readonly nodes: ReadonlyMap<string, JumpNode>) {
    // Sorted, so the names that start with a pattern's literal head are one range.
    this.defined = [...nodes].filter(([, n]) => !n.missing).map(([k]) => k).sort();
  }

  of(values: readonly string[]): { names: string[]; complete: boolean; reasons: string[] } {
    const names = new Set<string>();
    const reasons = new Set<string>();
    let complete = true;
    for (const value of values) {
      if (!value.includes(WILDCARD)) {
        const name = value.trim().toLowerCase();
        // A value that is no location (`$next = ''`, a typo) makes no edge.
        const node = this.nodes.get(name);
        if (node && !node.missing) names.add(name);
        continue;
      }
      complete = false;
      const found = this.wildcard(value.trim());
      // All wildcard: whatever made it so is already among the resolver's reasons.
      if (found === 'all') continue;
      if (found === 'too many') reasons.add('matches too many locations');
      else for (const n of found) names.add(n);
    }
    if (names.size > MAX_POSSIBLE_TARGETS) return { names: [], complete: false, reasons: ['too many targets'] };
    return { names: [...names], complete, reasons: [...reasons] };
  }

  // 'all' when it is all wildcard, 'too many' when it matches too much to be of use.
  private wildcard(value: string): string[] | 'all' | 'too many' {
    const cached = this.matches.get(value);
    if (cached) return cached;
    const re = wildcardMatcher(value);
    let found: string[] | 'all' | 'too many' = 'all';
    if (re) {
      const head = value.slice(0, value.indexOf(WILDCARD)).toLowerCase();
      const names: string[] = [];
      for (let i = this.firstWithPrefix(head); i < this.defined.length && this.defined[i].startsWith(head); i++) {
        if (!re.test(this.defined[i])) continue;
        names.push(this.defined[i]);
        // Past the limit the answer is 'too many' however many more match.
        if (names.length > MAX_POSSIBLE_TARGETS) break;
      }
      found = names.length > MAX_POSSIBLE_TARGETS ? 'too many' : names;
    }
    this.matches.set(value, found);
    return found;
  }

  // Index of the first name not sorting before `prefix`.
  private firstWithPrefix(prefix: string): number {
    let lo = 0, hi = this.defined.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.defined[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
