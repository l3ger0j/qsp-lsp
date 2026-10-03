/**
 * Keep the syntax errors of a `{…}` block inside that block.
 *
 * QSP finds where a `{…}` ends by balancing braces and quotes, whatever is
 * inside; the block is text until something runs it, and games keep lists
 * of words in such blocks. Tree-sitter parses the inside as code, and when
 * it isn't code, its error recovery can drop the `{` and take the rest of
 * the location with it: `local $x = {` becomes an error and a quote further
 * down an unclosed string. Which recovery wins depends on the text after
 * the block, so the grammar can't rule it out.
 *
 * When a parse has errors outside every block, each block's inside is
 * parsed on its own. The blocks that aren't code are blanked out (spaces,
 * so every position stays) and the location parsed again; their errors
 * come from their own parse.
 */
import type Parser from 'web-tree-sitter';
import { extractErrors, setContainedBlockErrors, type SyntaxError } from './extractErrors';
import { isDynamicArgCodeBlock } from './scopeUtils';

/** Parses `text`; `served` is what the tree's `node.text` reads (same length). */
export type ParseFn = (text: string, served: string) => Parser.Tree | null;

interface Position { row: number; column: number }

// Offsets of `{` and `}`, and their positions.
interface Block { open: number; close: number; openAt: Position; closeAt: Position }

// Nested blocks are handled inside their outer block's own parse.
const MAX_DEPTH = 3;

/**
 * Return `tree`, or a tree of `text` with its broken blocks blanked out
 * (deleting `tree`) when that leaves fewer errors outside blocks.
 */
export function containBlockErrors(tree: Parser.Tree, text: string, parse: ParseFn, depth = 0): Parser.Tree {
  // Text outside a location (no `# name` line) is never parsed as code.
  if (!tree.rootNode.hasError || depth >= MAX_DEPTH || !text.startsWith('#')) return tree;
  const escaping = errorsOutsideBlocks(tree);
  if (escaping === 0) return tree;
  const broken: { block: Block; errors: SyntaxError[] }[] = [];
  for (const block of topLevelBlocks(text, text.indexOf('\n') + 1)) {
    const errors = blockErrors(text, block, parse, depth);
    if (errors.length > 0) broken.push({ block, errors });
  }
  if (broken.length === 0) return tree;

  const blanked = blankBlocks(text, broken.map(b => b.block));
  const retry = parse(blanked, text);
  if (!retry) return tree;
  if (errorsOutsideBlocks(retry) >= escaping) {
    retry.delete();
    return tree;
  }

  const contained: SyntaxError[] = [];
  for (const { block, errors } of broken) {
    const codeBlock = codeBlockAt(retry, block.openAt);
    // A `{…}` in a comment is the comment's text.
    if (!codeBlock) continue;
    const stored = !isDynamicArgCodeBlock(codeBlock);
    for (const e of errors) contained.push({ ...e, inCodeBlock: true, inStoredBlock: stored || undefined });
  }
  setContainedBlockErrors(retry, contained);
  tree.delete();
  return retry;
}

function errorsOutsideBlocks(tree: Parser.Tree): number {
  let n = 0;
  for (const e of extractErrors(tree)) if (!e.inCodeBlock) n++;
  return n;
}

function topLevelBlocks(text: string, from: number): Block[] {
  if (from === 0) return [];
  const blocks: Block[] = [];
  let quote = 0;
  let depth = 0;
  let open = -1;
  let openAt: Position = { row: 0, column: 0 };
  let row = 1;
  let lineStart = from;
  for (let i = from; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x0a) {
      row++;
      lineStart = i + 1;
    }
    // A doubled quote inside a string closes and reopens it, which
    // leaves the same state as reading it as an escape.
    if (quote !== 0) {
      if (ch === quote) quote = 0;
    } else if (ch === 0x27 || ch === 0x22) {
      quote = ch;
    } else if (ch === 0x7b) {
      if (depth++ === 0) {
        open = i;
        openAt = { row, column: i - lineStart };
      }
    } else if (ch === 0x7d && depth > 0) {
      if (--depth === 0) blocks.push({ open, close: i, openAt, closeAt: { row, column: i - lineStart } });
    }
  }
  return blocks;
}

// The errors of a block's inside parsed as a location of its own. Its first
// line keeps its column, and rows are shifted back to where it stands.
function blockErrors(text: string, block: Block, parse: ParseFn, depth: number): SyntaxError[] {
  const iso = '# x\n' + ' '.repeat(block.openAt.column + 1) + text.slice(block.open + 1, block.close) + '\n---\n';
  const raw = parse(iso, iso);
  if (!raw) return [];
  const tree = containBlockErrors(raw, iso, parse, depth + 1);
  try {
    if (!tree.rootNode.hasError) return [];
    const shift = block.openAt.row - 1;
    const start = { row: block.openAt.row, column: block.openAt.column + 1 };
    return extractErrors(tree)
      .map(e => ({ ...e, startRow: e.startRow + shift, endRow: e.endRow + shift }))
      .filter(e => notBefore(e.startRow, e.startCol, start) && !notBefore(e.startRow, e.startCol, block.closeAt));
  } finally {
    tree.delete();
  }
}

function blankBlocks(text: string, blocks: Block[]): string {
  let out = '';
  let at = 0;
  for (const b of blocks) {
    out += text.slice(at, b.open + 1) + text.slice(b.open + 1, b.close).replace(/[^\r\n]/g, ' ');
    at = b.close;
  }
  return out + text.slice(at);
}

function codeBlockAt(tree: Parser.Tree, at: Position): Parser.SyntaxNode | null {
  let node: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition(at);
  while (node && !(node.type === 'code_block' && samePosition(node.startPosition, at))) {
    if (!samePosition(node.startPosition, at)) return null;
    node = node.parent;
  }
  return node;
}

function samePosition(a: Position, b: Position): boolean {
  return a.row === b.row && a.column === b.column;
}

function notBefore(row: number, col: number, p: Position): boolean {
  return row > p.row || (row === p.row && col >= p.column);
}
