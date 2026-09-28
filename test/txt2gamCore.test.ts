import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  decodeWith, encodeWith, isT2gError, parseTextWith, T2gErrorCode,
  type CreateT2gModule, type T2gModule,
} from '../src/common/txt2gamCore';

const VENDOR = path.join(__dirname, '..', 'vendor', 'txt2gam');
let mod: T2gModule;

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factory = require(path.join(VENDOR, 'txt2gam.js')) as CreateT2gModule;
  mod = await factory({ wasmBinary: new Uint8Array(fs.readFileSync(path.join(VENDOR, 'txt2gam.wasm'))) });
});

const source = "# старт\n*pl 'Привет'\n--- старт ---\n";

describe('txt2gamCore', () => {
  it('encodes and decodes back to the same locations', () => {
    const decoded = decodeWith(mod, encodeWith(mod, source));
    expect(decoded).toContain('# старт');
    expect(decoded).toContain("*pl 'Привет'");
  });

  it('is deterministic, which the build relies on to skip unchanged files', () => {
    expect(Buffer.from(encodeWith(mod, source)).equals(Buffer.from(encodeWith(mod, source)))).toBe(true);
  });

  it('rejects a wrong password with WRONG_PASSWORD', () => {
    const game = encodeWith(mod, source, { password: 'secret' });
    let error: unknown;
    try { decodeWith(mod, game, { password: 'wrong' }); } catch (e) { error = e; }
    expect(isT2gError(error, T2gErrorCode.WRONG_PASSWORD)).toBe(true);
  });

  it('decodes a UTF-16 LE file with a BOM', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')]);
    expect(parseTextWith(mod, new Uint8Array(bytes))).toBe(source);
  });
});
