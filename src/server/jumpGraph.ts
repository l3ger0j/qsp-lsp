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
  uri: string;
  line: number;
  text: string;
}

export interface JumpEdge {
  /** Lowercase names, matching `JumpNode.name.toLowerCase()`. */
  from: string;
  to: string;
  callType: JumpCallType;
  kind: 'exact';
  sites: JumpSite[];
}

/** A jump whose target the analysis can't name. */
export interface UnresolvedJump {
  from: string;
  callType: JumpCallType;
  /** The target expression, e.g. `$next`. */
  expr: string;
  site: JumpSite;
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

/**
 * Build the jump graph of `sources` (every project file, or one file).
 * Edges are grouped per (from, to, call type) with every site listed.
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
  const unresolved: UnresolvedJump[] = [];
  for (const { symbols } of docs) {
    for (const locSyms of symbols.locations.values()) {
      const from = locSyms.locationName.toLowerCase();
      for (const [to, target] of locSyms.locationRefs) {
        for (const ref of target.references) {
          // `loc 'name'` (does it exist?) is a location ref with no call type: not a jump.
          if (!ref.callType) continue;
          if (!nodes.has(to)) nodes.set(to, { name: target.name, missing: true });
          const key = `${from}\u0000${to}\u0000${ref.callType}`;
          let edge = edges.get(key);
          if (!edge) {
            edge = { from, to, callType: ref.callType, kind: 'exact', sites: [] };
            edges.set(key, edge);
          }
          edge.sites.push({ uri: ref.uri, line: ref.line, text: ref.callText ?? '' });
        }
      }
      for (const d of locSyms.dynamicLocationRefs) {
        if (!d.loc.callType) continue;
        unresolved.push({
          from,
          callType: d.loc.callType,
          expr: d.exprText,
          site: { uri: d.loc.uri, line: d.loc.line, text: d.loc.callText ?? d.exprText },
        });
      }
    }
  }

  for (const edge of edges.values()) edge.sites.sort((a, b) => a.uri.localeCompare(b.uri) || a.line - b.line);
  return { nodes: [...nodes.values()], edges: [...edges.values()], unresolved };
}
