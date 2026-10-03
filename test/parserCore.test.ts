import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { QspTreeSitterParser, extractErrors } from '../src/parser/treeSitter';
import { WASM_PATH } from './testHelpers';

describe('QspTreeSitterParser', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('initializes from an ArrayBuffer, which browser WASM loaders return', async () => {
    const bytes = fs.readFileSync(WASM_PATH);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const fromBuffer = new QspTreeSitterParser();
    await fromBuffer.init(async () => buffer);
    const tree = fromBuffer.parseOnce('# a\npl 1\n---\n');
    expect(tree?.rootNode.hasError).toBe(false);
    tree?.delete();
    fromBuffer.dispose();
  });

  // Between locations txt2gam looks only for `#`, so a `--` line there (an
  // ASCII table, a divider) is text, not the end of a location. The native
  // build the corpus tests use parsed the second case right while this WASM,
  // which the server uses, did not, so both are checked here.
  it('keeps "--" lines between locations as text', () => {
    const cases = [
      '# get_coords\n%result = [1, 2]\n--- get_coords ---\n\ny/x |  0   1\n----|--------   N = x + y * W\n   0|  0   1\n\n'
        + "@get_coords(10, 4, '[x]')   & !@ кортеж (2,2)\n\n# next\n*pl 'дальше'\n--- next ---\n",
      '# kdkkdkdd\n\n-- - ---------\n\ndkkkdkdk\n\nkdkdkd\nkdkd\n-----\n\ngoto\n',
    ];
    for (const text of cases) {
      const tree = parser.parseOnce(text)!;
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.namedChildren.map(n => n.type))
        .toEqual(text.includes('# next') ? ['location_block', 'inter_loc_text', 'location_block'] : ['location_block', 'inter_loc_text']);
      tree.delete();
    }
  });

  it('should parse a simple location', () => {
    const tree = parser.parseOnce(`# start
pl 'hello'
---
`);
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('source_file');
    expect(tree!.rootNode.hasError).toBe(false);

    const locBlock = tree!.rootNode.namedChildren.find(c => c.type === 'location_block');
    expect(locBlock).toBeDefined();
  });

  it('should report no errors for valid code', () => {
    const tree = parser.parseOnce(`# test
x = 1
if x > 0: pl 'positive'
---
`);
    expect(tree).not.toBeNull();
    const errors = extractErrors(tree!);
    expect(errors).toHaveLength(0);
  });

  it('should report errors for invalid syntax', () => {
    const tree = parser.parseOnce(`# test
if
---
`);
    expect(tree).not.toBeNull();
    const errors = extractErrors(tree!);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('QspTreeSitterParser — dispose', () => {
  it('should clean up all resources on dispose', async () => {
    const p = new QspTreeSitterParser();
    await p.init(async () => fs.readFileSync(WASM_PATH));
    p.parseOnce(`# loc1\nx = 1\n---\n`)?.delete();

    p.dispose();

    expect(p.isReady).toBe(false);
    expect(p.parseOnce(`# loc2\ny = 2\n---\n`)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Block keyword highlighting
// ──────────────────────────────────────────────────────────────────────

