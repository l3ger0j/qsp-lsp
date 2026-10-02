/**
 * `!@qsp-ignore` comments.
 *
 * Why
 * ───
 * - Authors silence a finding they intend, where it is, without turning
 *   the check off for the whole game.
 * - A directive covers exactly what it says: the next code line, its own
 *   line after `&`, the location, or the file; only the named checks and,
 *   after `:`, only the named things (case- and type-prefix-insensitive,
 *   Cyrillic included).
 * - A mistyped check name must not silently silence everything, and syntax
 *   errors and duplicate location names can't be hidden.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildLocationIndex } from '../src/common/locations';
import { normalizeSuppressedName, parseSuppressions } from '../src/common/suppressions';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { initParser, runDiagnostics } from './testHelpers';

const parse = (text: string) => parseSuppressions(text, buildLocationIndex(text));

describe('parseSuppressions', () => {
  it('silences the next code line, skipping blank lines, notes and stacked directives', () => {
    const s = parse('# a\n!@qsp-ignore unusedVariables\n\n! note\n!@QSP-IGNORE typeMismatch\nx = 1\ny = 2\n---\n');
    expect(s.problems).toEqual([]);
    expect(s.isSuppressed('unusedVariables', 'x', 5)).toBe(true);
    expect(s.isSuppressed('typeMismatch', undefined, 5)).toBe(true);
    expect(s.isSuppressed('unusedVariables', 'y', 6)).toBe(false);
    expect(s.isSuppressed('uninitializedVariables', 'x', 5)).toBe(false);
  });

  it('silences its own line after &', () => {
    const s = parse('# a\n*pl счёт & !@qsp-ignore uninitializedVariables\n*pl счёт\n---\n');
    expect(s.isSuppressed('uninitializedVariables', 'счёт', 1)).toBe(true);
    expect(s.isSuppressed('uninitializedVariables', 'счёт', 2)).toBe(false);
  });

  it('silences a whole location or file', () => {
    const text = '# a\nx = 1\n!@qsp-ignore-location unusedVariables\ny = 1\n---\n# b\nz = 1\n---\n!@qsp-ignore-file typeMismatch\n';
    const s = parse(text);
    expect(s.isSuppressed('unusedVariables', 'x', 1)).toBe(true);
    expect(s.isSuppressed('unusedVariables', 'z', 6)).toBe(false);
    expect(s.isSuppressed('typeMismatch', undefined, 6)).toBe(true);
  });

  it('narrows to the names after ":", ignoring case and the type prefix', () => {
    const s = parse('# a\n!@qsp-ignore-location uninitializedVariables, unusedVariables: Счёт, $имя\n---\n');
    expect(s.isSuppressed('uninitializedVariables', '$счёт', 1)).toBe(true);
    expect(s.isSuppressed('unusedVariables', 'ИМЯ', 1)).toBe(true);
    expect(s.isSuppressed('unusedVariables', 'другое', 1)).toBe(false);
    expect(s.isSuppressed('unusedVariables', undefined, 1)).toBe(false);
  });

  it('with no check named, silences every check that can be silenced', () => {
    const s = parse('# a\n!@qsp-ignore\ngs \'нет\'\n---\n');
    expect(s.isSuppressed('unresolvedLocationRefs', 'нет', 2)).toBe(true);
    expect(s.isSuppressed('syntax', undefined, 2)).toBe(false);
    expect(s.isSuppressed('duplicateLocations', 'a', 2)).toBe(false);
  });

  it('reports unknown and unsilenceable checks, and silences nothing for them', () => {
    const s = parse('# a\n!@qsp-ignore unusedVariable\nx = 1\n!@qsp-ignore duplicateLocations\n---\n!@qsp-ignore-location unusedVariables\n');
    expect(s.problems).toEqual([
      expect.objectContaining({ line: 1, startCol: 13, endCol: 27, message: expect.stringContaining("Unknown check 'unusedVariable'") }),
      expect.objectContaining({ line: 3, message: expect.stringContaining("'duplicateLocations' can't be ignored") }),
      expect.objectContaining({ line: 5, message: expect.stringContaining('must be inside a location') }),
    ]);
    expect(s.isSuppressed('unusedVariables', 'x', 2)).toBe(false);
  });

  it('ignores text that only mentions the directive', () => {
    const s = parse("# a\n*pl 'see qsp-ignore'\nx = 1 !@qsp-ignore unusedVariables\n---\n");
    expect(s.isSuppressed('unusedVariables', 'x', 2)).toBe(false);
  });

  it('normalizes names like QSP compares them', () => {
    expect(normalizeSuppressedName(' $Счёт ')).toBe('счёт');
    expect(normalizeSuppressedName('#x')).toBe('x');
  });
});

describe('suppression in diagnostics', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  it('hides only what the comments name and reports a mistyped one', () => {
    const code = [
      '# start',
      "!@qsp-ignore unresolvedLocationRefs: нет_такой",
      "gs 'нет_такой'",
      "gs 'другая'",
      '*pl счёт & !@qsp-ignore uninitializedVariables',
      '*pl счёт',
      '!@qsp-ignore uninitialisedVariables',
      '*pl имя',
      '---',
    ].join('\n') + '\n';
    const diags = runDiagnostics(parser, code, { unresolvedLocationRefs: true, uninitializedVariables: true });
    const summary = diags.map(d => `${d.range.start.line + 1}:${d.code}`);
    expect(summary).toEqual(expect.arrayContaining([
      '4:unresolvedLocationRefs', '6:uninitializedVariables', '7:suppression', '8:uninitializedVariables',
    ]));
    expect(summary).not.toContain('3:unresolvedLocationRefs');
    expect(summary).not.toContain('5:uninitializedVariables');
  });

  it('never hides a syntax error', () => {
    const diags = runDiagnostics(parser, '# a\n!@qsp-ignore\nif x = 1\n---\n', {});
    expect(diags.some(d => d.code === 'syntax')).toBe(true);
  });
});
