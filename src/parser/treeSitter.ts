/**
 * Tree-sitter integration for QSP language parsing.
 *
 * Wraps web-tree-sitter to provide incremental parsing of QSP documents.
 * Error extraction, symbol extraction, and block keyword highlighting
 * live in their own modules (extractErrors, extractSymbols, blockKeywords).
 *
 * Works in both Node.js (desktop) and browser (vscode.dev) contexts.
 */
import type Parser from 'web-tree-sitter';

// Re-export from sub-modules for backward compatibility
export { extractErrors, hasStructuralErrors } from './extractErrors';
export type { SyntaxError } from './extractErrors';
export { extractSymbols, isVariableDefinition } from './extractSymbols';
export { findBlockKeywordRanges } from './blockKeywords';
export type { KeywordRange } from './blockKeywords';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

/** Callback that returns WASM bytes or a URL/path to the grammar WASM. */
export type WasmLoader = () => Promise<string | Uint8Array | ArrayBuffer>;

/**
 * Optional callback that returns the directory containing the
 * tree-sitter.wasm runtime file.  Used by TreeSitter.init({ locateFile }).
 */
export type WasmDirProvider = () => string;

// ──────────────────────────────────────────────────────────────────────
// Incremental edit computation
// ──────────────────────────────────────────────────────────────────────

// ── Parse input ──────────────────────────────────────────────────────
//
// Given a string, web-tree-sitter 0.24 reads it through
// `index => text.slice(index)` and copies up to 5000 characters of what
// that returns into WASM memory on every call. The lexer calls back
// thousands of times per location, whenever it re-reads from a new
// position, so most of a parse went into copying: 54 of 76 s on a
// 978-location game. Short slices keep each call cheap.
//
// The tree keeps the same function to serve `node.text`, which reads
// whole ranges; once the parse is over it hands out the full tail
// again, so `node.text` stays one slice instead of many small pieces.
const PARSE_CHUNK = 128;

function parseText(parser: Parser, text: string, oldTree?: Parser.Tree): Parser.Tree {
  let parsing = true;
  const input = (index: number) => (parsing ? text.slice(index, index + PARSE_CHUNK) : text.slice(index));
  try {
    return parser.parse(input, oldTree);
  } finally {
    parsing = false;
  }
}

/**
 * Compute the minimal tree-sitter Edit descriptor between two texts.
 *
 * Uses a prefix/suffix scan: the prefix scan walks from the start of both
 * texts (tracking row/column as it goes) until the first difference, then
 * a suffix scan walks backwards from the end.  For a typical single-char
 * edit this touches only the changed region + a few surrounding bytes.
 *
 * Returns null if the texts are identical.
 */
export function computeTreeEdit(
  oldText: string,
  newText: string,
): Parser.Edit | null {
  const oldLen = oldText.length;
  const newLen = newText.length;
  const minLen = Math.min(oldLen, newLen);

  // ── Find common prefix, tracking row/column ──────────────────────
  let startIndex = 0;
  let row = 0;
  let lineStart = 0;
  while (startIndex < minLen &&
         oldText.charCodeAt(startIndex) === newText.charCodeAt(startIndex)) {
    if (oldText.charCodeAt(startIndex) === 10 /* \n */) {
      row++;
      lineStart = startIndex + 1;
    }
    startIndex++;
  }

  // ── Find common suffix (don't overlap with prefix) ───────────────
  //
  // Cap the suffix scan so that edits near the top of an 80 MB+ file
  // don't walk millions of identical trailing bytes.  A suffix match
  // longer than MAX_SUFFIX_SCAN proves the tail is structurally
  // unchanged; tree-sitter's Tree.edit() only needs accurate
  // startIndex / oldEndIndex / newEndIndex, and the positions just
  // anchor the byte-offset adjustment — they don't need to span the
  // full file.
  //
  // When the suffix scan hits the cap, we return null to force a
  // full (non-incremental) parse.  This is correct because the
  // incremental edit region would be so large (nearly the full file)
  // that re-parsing from scratch is actually faster.
  const MAX_SUFFIX_SCAN = 100_000; // bytes
  let oldEndIndex = oldLen;
  let newEndIndex = newLen;
  let suffixScanned = 0;
  while (oldEndIndex > startIndex && newEndIndex > startIndex &&
         oldText.charCodeAt(oldEndIndex - 1) === newText.charCodeAt(newEndIndex - 1)) {
    oldEndIndex--;
    newEndIndex--;
    suffixScanned++;
    if (suffixScanned >= MAX_SUFFIX_SCAN) {
      // The edit is tiny but the suffix match spans the full file —
      // computing the exact boundaries requires walking up to 80 MB.
      // Let the caller do a full parse instead.
      return null;
    }
  }

  // Texts are identical
  if (startIndex === oldEndIndex && startIndex === newEndIndex) return null;

  const startPosition = { row, column: startIndex - lineStart };

  // ── Compute old end position ─────────────────────────────────────
  let oldRow = row;
  let oldLineStart = lineStart;
  for (let i = startIndex; i < oldEndIndex; i++) {
    if (oldText.charCodeAt(i) === 10) {
      oldRow++;
      oldLineStart = i + 1;
    }
  }
  const oldEndPosition = { row: oldRow, column: oldEndIndex - oldLineStart };

  // ── Compute new end position ─────────────────────────────────────
  let newRow = row;
  let newLineStart = lineStart;
  for (let i = startIndex; i < newEndIndex; i++) {
    if (newText.charCodeAt(i) === 10) {
      newRow++;
      newLineStart = i + 1;
    }
  }
  const newEndPosition = { row: newRow, column: newEndIndex - newLineStart };

  return {
    startIndex,
    oldEndIndex,
    newEndIndex,
    startPosition,
    oldEndPosition,
    newEndPosition,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Parser wrapper
// ──────────────────────────────────────────────────────────────────────

export class QspTreeSitterParser {
  private parser: Parser | null = null;
  private language: Parser.Language | null = null;

  /**
   * Optional sink for parse failures that aren't a plain timeout (see
   * {@link reportUnexpectedParseError}). Kept as a plain callback rather
   * than importing `vscode-languageserver` here — this module stays
   * transport-agnostic and usable from the browser bundle. The server
   * wires this to `connection.console.error` via {@link setErrorReporter}.
   */
  private onUnexpectedError?: (message: string) => void;

  /**
   * Register a callback for parse failures that are NOT a plain
   * `setTimeoutMicros` timeout (e.g. a WASM runtime error). A plain
   * timeout is an expected, silent occurrence (the file is just huge or
   * pathological) and is not reported.
   */
  setErrorReporter(onUnexpectedError: (message: string) => void): void {
    this.onUnexpectedError = onUnexpectedError;
  }

  /**
   * Called from every `catch` around `parser.parse()`. web-tree-sitter
   * throws a plain `Error("Parsing failed")` for an ordinary timeout;
   * anything else (e.g. a WASM `RuntimeError`) indicates a real bug and
   * is worth surfacing instead of silently treating it like a timeout.
   */
  private reportUnexpectedParseError(err: unknown): void {
    const isPlainTimeout = err instanceof Error && err.message === 'Parsing failed';
    if (isPlainTimeout) return;
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    this.onUnexpectedError?.(`[QSP] Unexpected tree-sitter parse failure: ${message}`);
  }

  /**
   * Initialize the parser. Must be called once before parse().
   * @param wasmLoader Returns the grammar WASM bytes (or path).
   * @param wasmDir    If provided, returns the directory containing
   *                   `tree-sitter.wasm` (the web-tree-sitter runtime).
   */
  async init(wasmLoader: WasmLoader, wasmDir?: WasmDirProvider): Promise<void> {
    const TreeSitter = (await import('web-tree-sitter')).default;

    // Tell web-tree-sitter where to find its own tree-sitter.wasm runtime.
    const initOptions: Record<string, unknown> = {};
    if (wasmDir) {
      const dir = wasmDir();
      initOptions.locateFile = (file: string) => {
        // path.join may not exist in browser, so use simple concat
        return dir.endsWith('/') ? dir + file : dir + '/' + file;
      };
    }
    await TreeSitter.init(initOptions);

    this.parser = new TreeSitter();
    const wasmData = await wasmLoader();
    // Language.load takes string | Uint8Array; browser loaders typically hand over an ArrayBuffer.
    this.language = await TreeSitter.Language.load(
      wasmData instanceof ArrayBuffer ? new Uint8Array(wasmData) : wasmData,
    );
    this.parser.setLanguage(this.language);
  }

  get isReady(): boolean {
    return this.parser !== null;
  }

  /**
   * Parse a text (a location, an embedded code fragment). The caller owns
   * the tree and calls tree.delete() when done. Optionally accepts an
   * oldTree for incremental re-parsing (the caller must have called
   * tree.edit() on it before passing it here).
   */
  parseOnce(text: string, timeoutMicros = 5_000_000, oldTree?: Parser.Tree): Parser.Tree | null {
    if (!this.parser) return null;
    this.parser.setTimeoutMicros(timeoutMicros);
    try {
      return parseText(this.parser, text, oldTree);
    } catch (err) {
      // Timeout (or another parse failure). Reset the parser: web-tree-sitter
      // resumes a halted parse from where it left off on the next call
      // unless reset() clears that state, so the next parse — of another
      // location or document, the parser is shared — would silently continue
      // this one and produce a corrupted tree with wrong symbols and diagnostics.
      this.parser.reset();
      this.reportUnexpectedParseError(err);
      return null;
    }
  }

  /** Clean up all resources. */
  dispose(): void {
    this.parser?.delete();
    this.parser = null;
  }
}
