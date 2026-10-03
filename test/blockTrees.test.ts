import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import type Parser from 'web-tree-sitter';
import { QspTreeSitterParser, extractErrors } from '../src/parser/treeSitter';
import { blockTree, descendantAt, forEachDescendant, parentOf } from '../src/parser/blockTrees';
import { WASM_PATH } from './testHelpers';

const nodesOfType = (root: Parser.SyntaxNode, type: string) => {
  const found: Parser.SyntaxNode[] = [];
  forEachDescendant(root, n => { if (n.type === type) found.push(n); });
  return found;
};

const pointAt = (text: string, index: number) => {
  const before = text.slice(0, index);
  return { row: before.split('\n').length - 1, column: index - (before.lastIndexOf('\n') + 1) };
};

describe('block trees', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('keep the rows, columns and text a block has in the document', () => {
    const text = "# старт\r\n$x = 1 & dynamic { pl 'да' & $имя = 'Ёж'\r\n  ёлка = 2 }\r\n---\r\n";
    const tree = parser.parseOnce(text)!;
    const names = nodesOfType(tree.rootNode, 'variable_ref').map(n => n.text);
    expect(names).toEqual(['$x', '$имя', 'ёлка']);
    for (const n of nodesOfType(tree.rootNode, 'variable_ref')) {
      expect(text.slice(n.startIndex, n.endIndex)).toBe(n.text);
      expect(n.startPosition).toEqual(pointAt(text, n.startIndex));
    }
    tree.delete();
  });

  it('go into nested blocks, and parentOf climbs back out through each', () => {
    const tree = parser.parseOnce('# старт\ndynamic { dynamic { глубоко = 1 } }\n---\n')!;
    const inner = nodesOfType(tree.rootNode, 'variable_ref')[0];
    expect(inner.text).toBe('глубоко');
    const chain: string[] = [];
    for (let a = parentOf(inner); a; a = parentOf(a)) chain.push(a.type);
    expect(chain.filter(t => t === 'code_block')).toHaveLength(2);
    expect(chain.filter(t => t === 'location_block')).toHaveLength(1);
    expect(chain.at(-1)).toBe('source_file');
    tree.delete();
  });

  it('find the node at a point inside a block', () => {
    const text = '# старт\n$код = { pl цель }\n---\n';
    const tree = parser.parseOnce(text)!;
    const node = descendantAt(tree.rootNode, pointAt(text, text.indexOf('цель') + 1));
    expect(node.text).toBe('цель');
    tree.delete();
  });

  it('are deleted with the tree they were parsed for', () => {
    const tree = parser.parseOnce('# старт\ndynamic { pl 1 }\n---\n')!;
    const sub = blockTree(tree.rootNode.descendantsOfType('code_block')[0])!;
    let deleted = false;
    const deleteSub = sub.delete.bind(sub);
    sub.delete = () => { deleted = true; deleteSub(); };
    tree.delete();
    expect(deleted).toBe(true);
  });

  it('keep a word list that is no code from touching anything outside its block', () => {
    const words = Array.from({ length: 150 }, (_, i) => `Имя${i}`);
    const lines = Array.from({ length: 30 }, (_, l) => '    ' + words.slice(l * 5, l * 5 + 5).join(', ') + ',');
    const text = ['# старт', 'local $список = {', ...lines, '}', "scanstr '$имена', $список, '[\\w-]+'", '--- старт ---', ''].join('\n');
    const tree = parser.parseOnce(text)!;
    expect(tree.rootNode.hasError).toBe(false);
    const errors = extractErrors(tree);
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) {
      expect(e.inStoredBlock).toBe(true);
      expect(e.startRow).toBeGreaterThanOrEqual(1);
      expect(e.endRow).toBeLessThanOrEqual(31);
    }
    tree.delete();
  });

  it('report a block never closed at its brace, as QSP does', () => {
    const tree = parser.parseOnce('# старт\n$x = { a, b\npl 2\n--- старт ---\n')!;
    expect(extractErrors(tree)).toEqual([
      expect.objectContaining({ startRow: 1, startCol: 5, message: "Unclosed '{'" }),
    ]);
    tree.delete();
  });

  it('leave a quote the block leaves open an error, as QSP does', () => {
    const tree = parser.parseOnce("# старт\n$s = {\n  О'Хара,\n}\n--- старт ---\n")!;
    expect(extractErrors(tree).some(e => !e.inCodeBlock)).toBe(true);
    tree.delete();
  });
});
