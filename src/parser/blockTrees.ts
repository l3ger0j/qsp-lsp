/**
 * The way into and out of `{…}` blocks.
 *
 * Every walk that goes into a `code_block` gets its statements from
 * {@link blockStatements}, and every walk up the tree goes through
 * {@link parentOf}, so the walks don't depend on where a block's
 * statements are kept.
 */
import type Parser from 'web-tree-sitter';

/** The statements of a `code_block`, in order. */
export function blockStatements(block: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return block.children;
}

/** `node`'s parent; for a block's statement, the `code_block`. */
export function parentOf(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return node.parent;
}

/** The smallest node at `point` under `root`, inside its blocks too. */
export function descendantAt(root: Parser.SyntaxNode, point: Parser.Point): Parser.SyntaxNode {
  return root.descendantForPosition(point);
}

/** The nodes of `types` under `root`, inside its blocks too, found by tree-sitter. */
export function descendantsOfType(root: Parser.SyntaxNode, types: string | string[]): Parser.SyntaxNode[] {
  return root.descendantsOfType(types);
}

/**
 * Visit `root` and every node under it, the statements of its blocks too,
 * in document order. `visit` returning `false` skips a node's children;
 * `leave`, if given, runs after a node's children, for every visited node.
 */
export function forEachDescendant(
  root: Parser.SyntaxNode,
  visit: (node: Parser.SyntaxNode) => boolean | void,
  leave?: (node: Parser.SyntaxNode) => void,
): void {
  const cursor = root.walk();
  const step = (): void => {
    const node = cursor.currentNode;
    if (visit(node) !== false) {
      if (node.type === 'code_block') {
        for (const stmt of blockStatements(node)) forEachDescendant(stmt, visit, leave);
      } else if (cursor.gotoFirstChild()) {
        do { step(); } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    }
    leave?.(node);
  };
  try {
    step();
  } finally {
    cursor.delete();
  }
}
