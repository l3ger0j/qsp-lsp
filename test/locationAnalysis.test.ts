/**
 * Symbols of a location parsed alone (src/server/locationAnalysis.ts), as
 * large files get them in the editor and in the project scan.
 *
 * Why
 * ───
 * Syntax errors can hide actions and labels from tree-sitter inside ERROR
 * nodes. A whole-file parse adds them from the text; a location parsed
 * alone must too, or the Outline and action checks of a large or closed
 * file lose them.
 * A syntax error tree-sitter can't recover from (an `if` never closed,
 * prose written into the code) leaves no `location_block` at all, only an
 * ERROR node holding the header and the statements. Those still give
 * symbols: a location filled from the text alone (`regexOnly`) has no
 * variables or jumps, and turns off the "never used" checks of the whole
 * project.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { extractLocationSymbols } from '../src/server/locationAnalysis';
import { initParser } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

function symbolsOf(text: string) {
  const tree = parser.parseOnce(text)!;
  try {
    return extractLocationSymbols(tree, 'test://loc', 'комната', text, undefined);
  } finally {
    tree.delete();
  }
}

describe('extractLocationSymbols', () => {
  it('adds an action a syntax error hid, from the text, without doubling labels', () => {
    const symbols = symbolsOf("# комната\n(((\nact 'взять':\n*pl 1\nend\n:метка\n--- комната ---\n");
    expect(symbols.hasErrors).toBe(true);
    expect(symbols.actions.map(a => [a.name, a.definition?.line])).toEqual([['взять', 2]]);
    expect([...symbols.allLabelSymbols()].map(l => l.name)).toEqual(['метка']);
    expect(symbols.regexOnly).toBe(false);
  });

  it('leaves a location without errors as tree-sitter found it', () => {
    const symbols = symbolsOf("# комната\nact 'взять':\n  *pl 1\nend\n:метка\n--- комната ---\n");
    expect(symbols.hasErrors).toBe(false);
    expect(symbols.actions.map(a => a.name)).toEqual(['взять']);
    expect([...symbols.allLabelSymbols()].map(l => l.name)).toEqual(['метка']);
  });

  it('takes the symbols of a location whose syntax error leaves no location block', () => {
    const text = "# комната\nсчёт = 1\nif счёт = 1:\n  pl 'a'\nact 'выйти':\n  gt 'кухня'\nend\n--- комната ---\n";
    const tree = parser.parseOnce(text)!;
    expect(tree.rootNode.namedChildren.map(n => n.type)).toEqual(['ERROR']);
    tree.delete();

    const symbols = symbolsOf(text);
    expect(symbols.regexOnly).toBe(false);
    expect(symbols.hasErrors).toBe(true);
    expect(symbols.findVariable('счёт')?.hasValueDefinition).toBe(true);
    expect([...symbols.locationRefs.keys()]).toEqual(['кухня']);
    expect(symbols.actions.map(a => a.name)).toEqual(['выйти']);
  });
});
