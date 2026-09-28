/**
 * txt2gam calls that don't depend on how the Emscripten module is loaded.
 * The VS Code client loads it through `vscode.workspace.fs` (desktop and
 * web); the MCP server loads it from disk. Both encode and decode through
 * these functions, so their output is identical.
 *
 * A `Txt2gam` instance is created and destroyed around every call so the
 * library's internal state is never shared between concurrent calls.
 */

// ── Type declarations for the Emscripten module ───────────────────────

/** The Emscripten module factory exported by txt2gam.js. */
export type CreateT2gModule = (opts?: {
  wasmBinary?: Uint8Array;
  print?:    (s: string) => void;
  printErr?: (s: string) => void;
}) => Promise<T2gModule>;

export interface T2gModule {
  Txt2gam: new () => Txt2gam;
  /** Error class thrown by all Txt2gam methods on failure. */
  T2gError: new (code: number) => T2gError;
  T2G_ERROR_NONE:           number; // 0
  T2G_ERROR_FAILED:         number; // 1
  T2G_ERROR_INVALID_DATA:   number; // 2
  T2G_ERROR_WRONG_PASSWORD: number; // 3
  T2G_ERROR_NO_MEMORY:      number; // 10
}

/** The `Txt2gam` binding injected by the --post-js shim. */
export interface Txt2gam {
  /**
   * Parse raw text bytes (with optional BOM) to a JS string.
   * BOM takes priority; `isUnicode` is the fallback encoding hint
   * (true = UTF-8, false = ANSI/CP1251).
   */
  parseText(data: Uint8Array, isUnicode: boolean): string | null;

  /**
   * Encode a text source to QSP binary game data.
   *
   * @param text        The .qsps source (UTF-16 JS string).
   * @param locStart    Location-start marker, or null for `"#"`.
   * @param locEnd      Location-end marker, or null for `"--"`.
   * @param isOldFormat `true` to use the old QSP binary format.
   * @param isUnicode   `true` to encode game strings as UTF-16;
   *                    `false` for ANSI/CP1251.
   * @param password    Game password, or null for the default `"No"`.
   * @returns Binary game data.
   * @throws {T2gError} On failure (`WRONG_PASSWORD`, `FAILED`, etc.).
   */
  textToGame(
    text: string,
    locStart: string | null,
    locEnd: string | null,
    isOldFormat: boolean,
    isUnicode: boolean,
    password: string | null,
  ): Uint8Array;

  /**
   * Decode QSP binary game data to a text source.
   *
   * @param gameBytes   The raw `.qsp` file bytes.
   * @param password    Game password, or null for the default `"No"`.
   * @param locStart    Location-start marker, or null for `"#"`.
   * @param locEnd      Location-end marker, or null for `"--"`.
   * @returns The .qsps source as a JS string.
   * @throws {T2gError} On failure (`WRONG_PASSWORD`, `INVALID_DATA`, etc.).
   */
  gameToText(
    gameBytes: Uint8Array,
    password: string | null,
    locStart: string | null,
    locEnd: string | null,
  ): string;

  /** Free library resources. */
  destroy(): void;
}

// ── Error type ───────────────────────────────────────────────────────

/**
 * Error thrown by Txt2gam methods on failure.
 * `code` matches one of the `T2G_ERROR_*` constants on the module.
 */
export interface T2gError extends Error {
  name: 'T2gError';
  code: number;
}

/** Return true when `e` is a T2gError with the given code. */
export function isT2gError(e: unknown, code?: number): e is T2gError {
  return (
    typeof e === 'object' && e !== null &&
    (e as T2gError).name === 'T2gError' &&
    (code === undefined || (e as T2gError).code === code)
  );
}

/**
 * Error code constants — mirrored from the Emscripten module so callers
 * don't need access to the raw module object.
 */
export const T2gErrorCode = {
  FAILED:         1,
  INVALID_DATA:   2,
  WRONG_PASSWORD: 3,
  NO_MEMORY:      10,
} as const;

// ── Options types ─────────────────────────────────────────────────────

export interface EncodeOptions {
  /** Game password (default: `"No"`). */
  password?: string;
}

export interface DecodeOptions {
  /** Game password (default: `"No"`). */
  password?: string;
}

// ── Module singleton ──────────────────────────────────────────────────

// ── Calls ─────────────────────────────────────────────────────────────

/**
 * Encode a .qsps text source to a QSP binary game file.
 * @throws {T2gError} On failure (e.g. `FAILED`).
 */
export function encodeWith(mod: T2gModule, text: string, opts: EncodeOptions = {}): Uint8Array {
  const t2g = new mod.Txt2gam();
  try {
    return t2g.textToGame(text, null, null, false, true, opts.password ?? null);
  } finally {
    t2g.destroy();
  }
}

/**
 * Decode a QSP binary game file to a .qsps text source.
 * @throws {T2gError} `WRONG_PASSWORD` for a wrong password, `INVALID_DATA` for a corrupt file.
 */
export function decodeWith(mod: T2gModule, gameBytes: Uint8Array, opts: DecodeOptions = {}): string {
  const t2g = new mod.Txt2gam();
  try {
    return t2g.gameToText(gameBytes, opts.password ?? null, null, null);
  } finally {
    t2g.destroy();
  }
}

/**
 * Parse raw text file bytes (with optional BOM) to a JS string.
 * `isUnicode` is the fallback when there is no BOM: UTF-8, or ANSI/CP1251.
 */
export function parseTextWith(mod: T2gModule, data: Uint8Array, isUnicode = true): string | null {
  const t2g = new mod.Txt2gam();
  try {
    return t2g.parseText(data, isUnicode);
  } finally {
    t2g.destroy();
  }
}
