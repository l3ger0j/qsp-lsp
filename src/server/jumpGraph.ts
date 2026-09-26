// ── Jump graph ───────────────────────────────────────────────────────
//
// Which location jumps to or calls which, built from the symbols the
// analysis already has: `locationRefs` for literal targets, and
// `dynamicLocationRefs` for targets that are expressions. Served to the
// client as `qsp/jumpGraph` and drawn by the Jump Graph webview.

import type { DocumentSymbols, LocationEntry } from '../parser';

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
  kind: 'exact';
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
export function buildJumpGraph(sources: Iterable<JumpGraphSource>): JumpGraph {
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
        const key = `${from}\u0000${d.loc.callType}`;
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
        addSite(group.sites, site(d.loc.uri, fromUri, d.loc.line, d.loc.callText ?? d.exprText));
      }
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], unresolved: [...unresolved.values()] };
}
