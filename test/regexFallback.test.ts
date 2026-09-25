import { describe, it, expect } from 'vitest';
import { DocumentSymbols } from '../src/parser/symbolTable';
import { extractLabelsFromLines } from '../src/server/regexFallback';

// Lite mode (vscode.dev) has only the regex fallback, so its label names
// must match grammar.js `label_name`: up to `&` or end of line, trimmed.
describe('extractLabelsFromLines', () => {
  function labels(lines: string[]) {
    const locSyms = new DocumentSymbols('file:///l.qsps').addLocation('l', {
      uri: 'file:///l.qsps', line: 0, column: 0, endLine: 0, endColumn: 1,
    });
    extractLabelsFromLines(lines, 0, locSyms, 'file:///l.qsps');
    return [...locSyms.allLabelSymbols()].map(s => ({ name: s.name, col: s.definition!.column, end: s.definition!.endColumn }));
  }

  it('keeps spaces and punctuation that the grammar allows in a label name', () => {
    expect(labels([':метка 2', ':выход-1'])).toEqual([
      { name: 'метка 2', col: 0, end: 8 },
      { name: 'выход-1', col: 0, end: 8 },
    ]);
  });

  it('stops at `&` and trims surrounding spaces', () => {
    expect(labels(['  :  loop start  & pl 1'])).toEqual([{ name: 'loop start', col: 2, end: 15 }]);
  });

  it('ignores a bare colon', () => {
    expect(labels([':', ':   '])).toEqual([]);
  });
});
