// ── Tree statistics ──────────────────────────────────────────────────
//
// How often each grammar construct occurs in a tree and how long it is:
// the shape of a game without its text. The performance report carries
// it so a synthetic game of the same shape can reproduce a problem.

import type Parser from 'web-tree-sitter';

/** Per node type: how many, their total and largest length in characters. */
export interface NodeTypeCount {
  count: number;
  chars: number;
  maxChars: number;
}

/** Node-type counts plus the deepest nesting seen, accumulated over trees. */
export interface TreeStats {
  types: Map<string, NodeTypeCount>;
  maxDepth: number;
}

/** A fresh, empty accumulator. */
export function newTreeStats(): TreeStats {
  return { types: new Map(), maxDepth: 0 };
}

/**
 * Add the named nodes of `tree` to `stats`. Walks with a cursor, so it
 * allocates no node objects: the report is built for games of millions
 * of nodes.
 */
export function countNodeTypes(tree: Parser.Tree, stats: TreeStats): void {
  const cursor = tree.walk();
  let depth = 0;
  try {
    for (;;) {
      if (cursor.nodeIsNamed) {
        const chars = cursor.endIndex - cursor.startIndex;
        const t = stats.types.get(cursor.nodeType);
        if (t) {
          t.count++;
          t.chars += chars;
          if (chars > t.maxChars) t.maxChars = chars;
        } else {
          stats.types.set(cursor.nodeType, { count: 1, chars, maxChars: chars });
        }
        if (depth > stats.maxDepth) stats.maxDepth = depth;
      }
      if (cursor.gotoFirstChild()) {
        depth++;
        continue;
      }
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return;
        depth--;
      }
    }
  } finally {
    cursor.delete();
  }
}

/** Fold `from` into `into`. */
export function mergeTreeStats(into: TreeStats, from: TreeStats): void {
  for (const [type, c] of from.types) {
    const t = into.types.get(type);
    if (t) {
      t.count += c.count;
      t.chars += c.chars;
      if (c.maxChars > t.maxChars) t.maxChars = c.maxChars;
    } else {
      into.types.set(type, { ...c });
    }
  }
  if (from.maxDepth > into.maxDepth) into.maxDepth = from.maxDepth;
}
