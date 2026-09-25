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

/**
 * Time budget for a from-scratch parse of `textLength` characters.
 * A normal file parses at roughly 8 µs/char, so this allows about twice that,
 * with a 2 s floor. Anything slower is GLR blow-up and should give up early.
 * The server is single-threaded, so every request waits while a parse runs.
 */
export function fullParseTimeoutMicros(textLength: number): number {
  return Math.max(2_000_000, textLength * 16);
}

// ──────────────────────────────────────────────────────────────────────
// Incremental edit computation
// ──────────────────────────────────────────────────────────────────────

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
  private trees = new Map<string, Parser.Tree>();
  private oldTexts = new Map<string, string>();
  private _wasLastParseIncremental = false;
  private _lastEdit: { startIndex: number; newEndIndex: number } | null = null;

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

  /** Whether the last parse() call used incremental parsing. */
  get wasLastParseIncremental(): boolean {
    return this._wasLastParseIncremental;
  }

  /**
   * The edit range from the last incremental parse, or null.
   * Used by extractSymbols to determine which location blocks overlap
   * the edit and need re-extraction (hasChanges on the new tree is
   * unreliable in web-tree-sitter).
   */
  get lastEdit(): { startIndex: number; newEndIndex: number } | null {
    return this._lastEdit;
  }

  /**
   * Parse a full document, using incremental parsing when possible.
   *
   * When we have a previous tree and the previous text, we compute the
   * minimal edit (prefix/suffix scan), call Tree#edit() so byte offsets
   * are adjusted, then pass the old tree to parser.parse() for
   * incremental re-parsing.  This can reduce a multi-second full parse
   * to a few milliseconds for typical single-character edits.
   */
  parse(uri: string, text: string): Parser.Tree | null {
    if (!this.parser) return null;

    const oldTree = this.trees.get(uri);
    const oldText = this.oldTexts.get(uri);

    // Try incremental parse when we have a previous tree and text.
    if (oldTree && oldText !== undefined) {
      // Texts are truly identical — return existing tree unchanged.
      if (oldText === text) {
        this._wasLastParseIncremental = false;
        this._lastEdit = null;
        return oldTree;
      }

      const edit = computeTreeEdit(oldText, text);
      if (edit) {
        // Incremental parse: apply edit and reuse old tree structure.
        oldTree.edit(edit);
        this.parser.setTimeoutMicros(5_000_000); // 5 seconds
        let tree: Parser.Tree;
        try {
          tree = this.parser.parse(text, oldTree);
        } catch (err) {
          // Timeout (or another parse failure) — oldTree is corrupted by
          // edit(), discard it. Critically, also reset() the *parser*:
          // web-tree-sitter resumes a halted parse from where it left off
          // on the next call unless reset() clears that state, so without
          // this the next parse() for a *different* document/location
          // would silently continue this failed parse and produce a
          // corrupted tree with wrong symbols/diagnostics.
          this.parser.reset();
          this.reportUnexpectedParseError(err);
          oldTree.delete();
          this.trees.delete(uri);
          this.oldTexts.delete(uri);
          this._wasLastParseIncremental = false;
          this._lastEdit = null;
          return null;
        }
        oldTree.delete();
        this.trees.set(uri, tree);
        this.oldTexts.set(uri, text);
        this._wasLastParseIncremental = true;
        this._lastEdit = { startIndex: edit.startIndex, newEndIndex: edit.newEndIndex };
        return tree;
      }
      // computeTreeEdit returned null — the suffix scan hit the 100 KB
      // cap or edit range is too large for efficient incremental parse.
      // Fall through to a fresh full parse below.
    }

    // Full parse (initial load, capped suffix, or no prior state).
    if (oldTree) oldTree.delete();
    this.parser.setTimeoutMicros(fullParseTimeoutMicros(text.length));
    let tree: Parser.Tree;
    try {
      tree = this.parser.parse(text);
    } catch (err) {
      // Initial parse timed out (or failed another way) — reset() so the
      // *next* parse() call (possibly for a different document) doesn't
      // silently resume this halted parse. See the comment in the
      // incremental branch above for why this matters.
      this.parser.reset();
      this.reportUnexpectedParseError(err);
      this.trees.delete(uri);
      this.oldTexts.delete(uri);
      this._wasLastParseIncremental = false;
      this._lastEdit = null;
      return null;
    }
    this.trees.set(uri, tree);
    this.oldTexts.set(uri, text);
    this._wasLastParseIncremental = false;
    this._lastEdit = null;
    return tree;
  }

  /** Get the most recent tree for a document. */
  getTree(uri: string): Parser.Tree | null {
    return this.trees.get(uri) ?? null;
  }

  /**
   * Parse a standalone text fragment without caching the tree.
   * The caller is responsible for calling tree.delete() when done.
   * Used for per-location parsing of large files.
   * Optionally accepts an oldTree for incremental re-parsing (the caller
   * must have called tree.edit() on it before passing it here).
   */
  parseOnce(text: string, timeoutMicros = 5_000_000, oldTree?: Parser.Tree): Parser.Tree | null {
    if (!this.parser) return null;
    this.parser.setTimeoutMicros(timeoutMicros);
    try {
      return this.parser.parse(text, oldTree);
    } catch (err) {
      // Timeout (or another parse failure). reset() so the next parse()
      // (for a different location/document — the parser is shared across
      // all of them) doesn't resume this halted parse. See parse() above.
      this.parser.reset();
      this.reportUnexpectedParseError(err);
      return null;
    }
  }

  /** Remove the cached tree when a document is closed. */
  removeTree(uri: string): void {
    this.trees.get(uri)?.delete();
    this.trees.delete(uri);
    this.oldTexts.delete(uri);
  }

  /** Clean up all resources. */
  dispose(): void {
    for (const tree of this.trees.values()) tree.delete();
    this.trees.clear();
    this.oldTexts.clear();
    this.parser?.delete();
    this.parser = null;
  }
}
