/**
 * SHA-256 for library downloads.
 *
 * Why
 * ───
 * - The checksum is what stops a broken or swapped library file from
 *   reaching a game, so it must match the standard exactly, including at
 *   the block-padding edges (55, 56, 64 bytes).
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { sha256Hex } from '../src/common/sha256';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('sha256Hex', () => {
  it('matches the standard test vectors', () => {
    expect(sha256Hex(bytes(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('agrees with Node\'s crypto around block boundaries and on Cyrillic text', () => {
    const lengths = [1, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 100_000];
    for (const n of lengths) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff);
      expect(sha256Hex(data)).toBe(createHash('sha256').update(data).digest('hex'));
    }
    const text = bytes('# диалог_init\n*pl \'Привет\'\n--- диалог_init ---\n');
    expect(sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'));
  });
});
