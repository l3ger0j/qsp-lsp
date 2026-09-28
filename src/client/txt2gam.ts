/**
 * Lazy wrapper around the txt2gam Emscripten WASM module.
 *
 * The module is loaded once on first use; subsequent calls reuse the
 * same instance.  The WASM binary is read via `vscode.workspace.fs`
 * so that the same code works on both the desktop Node.js extension
 * host and the browser extension host (VS Code for Web). The calls
 * themselves live in src/common/txt2gamCore.ts.
 */

import * as vscode from 'vscode';
import * as logger from './logger';
import {
  decodeWith,
  encodeWith,
  parseTextWith,
  type CreateT2gModule,
  type DecodeOptions,
  type EncodeOptions,
  type T2gModule,
} from '../common/txt2gamCore';

export { isT2gError, T2gErrorCode, type T2gError, type EncodeOptions, type DecodeOptions } from '../common/txt2gamCore';

let modulePromise: Promise<T2gModule> | undefined;

/**
 * Lazily load (and cache) the txt2gam Emscripten module.
 * The WASM binary is read from `out/client/txt2gam.wasm` relative to
 * the extension root, which works on both desktop and VS Code for Web.
 */
function getModule(extensionUri: vscode.Uri): Promise<T2gModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const wasmUri  = vscode.Uri.joinPath(extensionUri, 'out', 'client', 'txt2gam.wasm');
      const wasmData = await vscode.workspace.fs.readFile(wasmUri);

      // vendor/txt2gam/txt2gam.js is bundled into the client bundles by esbuild.
      // The dynamic import resolves to the bundled module at runtime.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const factory: CreateT2gModule = require('txt2gamJs');
      return factory({
        wasmBinary: wasmData,
        print:    (s: string) => logger.log(`[WASM] ${s}`),
        printErr: (s: string) => logger.log(`[WASM] ${s}`),
      });
    })();
  }
  return modulePromise;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Encode a .qsps text source to a QSP binary game file.
 *
 * @param extensionUri  `context.extensionUri` from the `activate` call.
 * @param text          The combined .qsps source text.
 * @param opts          Encoding options.
 * @returns `Uint8Array` with the binary game data.
 * @throws {T2gError}  On encoding failure (e.g. `WRONG_PASSWORD`, `FAILED`).
 */
export async function encodeTextToGame(
  extensionUri: vscode.Uri,
  text: string,
  opts: EncodeOptions = {},
): Promise<Uint8Array> {
  const mod = await getModule(extensionUri);
  logger.log(`[Encode] ${text.length.toLocaleString()} chars...`);
  const result = encodeWith(mod, text, opts);
  logger.log(`[Encode] Done: ${(result.byteLength / 1024).toFixed(1)} kb`);
  return result;
}

/**
 * Decode a QSP binary game file to a .qsps text source.
 *
 * @param extensionUri  `context.extensionUri` from the `activate` call.
 * @param gameBytes     The raw `.qsp` file bytes.
 * @param opts          Decoding options.
 * @returns The .qsps text as a JS string.
 * @throws {T2gError}  On failure — notably `WRONG_PASSWORD` when the
 *                     password is incorrect, `INVALID_DATA` for corrupt files.
 */
export async function decodeGameToText(
  extensionUri: vscode.Uri,
  gameBytes: Uint8Array,
  opts: DecodeOptions = {},
): Promise<string> {
  const mod = await getModule(extensionUri);
  logger.log(`[Decode] ${(gameBytes.byteLength / 1024).toFixed(1)} kb...`);
  const result = decodeWith(mod, gameBytes, opts);
  logger.log(`[Decode] Done: ${result.length.toLocaleString()} chars`);
  return result;
}

/**
 * Parse raw text file bytes (with optional BOM) to a JS string.
 * Handles UTF-16 LE/BE, UTF-8, and ANSI/CP1251.
 *
 * @param extensionUri `context.extensionUri` from the `activate` call.
 * @param data         Raw file bytes.
 * @param isUnicode    Fallback encoding hint when no BOM is present
 *                     (`true` = UTF-8, `false` = ANSI/CP1251).
 */
export async function parseTextBytes(
  extensionUri: vscode.Uri,
  data: Uint8Array,
  isUnicode = true,
): Promise<string | null> {
  return parseTextWith(await getModule(extensionUri), data, isUnicode);
}

/**
 * Reset the cached module (e.g. for testing or if the WASM file changes).
 * @internal
 */
export function resetModuleCache(): void {
  modulePromise = undefined;
}
