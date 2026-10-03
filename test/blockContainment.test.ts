import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { QspTreeSitterParser, extractErrors, computeTreeEdit } from '../src/parser/treeSitter';
import { hasContainedBlocks } from '../src/parser/extractErrors';
import { WASM_PATH } from './testHelpers';

// A word list whose last word ends in a comma, followed by a line with
// two strings: tree-sitter's error recovery used to drop the `{` and report
// `local` as unexpected and the quotes as an unclosed string.
const location = (head: string, after = "scanstr '$названия', $сырой_список, '[\\w-]+'") => [
  '# старт',
  `${head} {`,
  '    Яблоко, Груша, Слива,',
  '    Вишня, Малина, Айва,',
  '}',
  after,
  '--- старт ---',
  '',
].join('\n');

describe('block containment', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('keeps the errors of a word list inside its block', () => {
    const text = location('local $сырой_список =');
    const tree = parser.parseOnce(text)!;
    const errors = extractErrors(tree);
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) {
      expect(e).toMatchObject({ inCodeBlock: true, inStoredBlock: true });
      expect(e.startRow).toBeGreaterThanOrEqual(2);
      expect(e.endRow).toBeLessThanOrEqual(3);
    }
    const block = tree.rootNode.descendantsOfType('code_block')[0];
    expect(block.text).toBe(text.slice(text.indexOf('{'), text.indexOf('}') + 1));
    tree.delete();
  });

  it('marks the same block run by dynamic as code, not as a stored block', () => {
    const tree = parser.parseOnce(location('dynamic', "$a = 'x' + 'y'"))!;
    const errors = extractErrors(tree);
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) {
      expect(e.inCodeBlock).toBe(true);
      expect(e.inStoredBlock).toBeUndefined();
    }
    tree.delete();
  });

  it('leaves a parse alone when its errors are outside every block', () => {
    const tree = parser.parseOnce("# старт\nif x = 1\n  $s = { pl 'да' }\nend\n--- старт ---\n")!;
    expect(hasContainedBlocks(tree)).toBe(false);
    expect(extractErrors(tree).some(e => e.message.includes("Missing ':'"))).toBe(true);
    tree.delete();
  });

  it('keeps a quote the block leaves open an error, as QSP does', () => {
    const tree = parser.parseOnce("# старт\n$s = {\n  О'Хара,\n}\n--- старт ---\n")!;
    expect(extractErrors(tree).some(e => !e.inCodeBlock)).toBe(true);
    tree.delete();
  });

  it('gives an edited text the errors a fresh parse gives it', () => {
    const before = location('local $сырой_список =');
    const after = before.replace('Груша', 'Персик');
    const old = parser.parseOnce(before)!;
    old.edit(computeTreeEdit(before, after)!);
    const edited = parser.parseOnce(after, 5_000_000, old)!;
    const fresh = parser.parseOnce(after)!;
    expect(extractErrors(edited)).toEqual(extractErrors(fresh));
    expect(extractErrors(edited).every(e => e.inStoredBlock)).toBe(true);
    for (const t of [old, edited, fresh]) t.delete();
  });
});
