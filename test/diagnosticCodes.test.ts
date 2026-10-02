/**
 * Diagnostic codes.
 *
 * Why
 * ───
 * - A code names its check's `qsp.diagnostics.<code>` setting: the "turn
 *   off" quick fix writes that setting, and `!@qsp-ignore` comments use the
 *   same names, so every code must have a real setting, and every boolean
 *   check setting a code.
 * - Every diagnostic carries a code (and the name it is about), so the
 *   Problems panel can filter by check and the quick fixes know what to do.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CHECK_CODES, OTHER_CODES, SUPPRESSIBLE_CODES } from '../src/common/diagnosticCodes';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { initParser, runDiagnostics } from './testHelpers';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const settings: Record<string, { type: string }> = pkg.contributes.configuration.properties;

describe('diagnostic codes', () => {
  it('match the qsp.diagnostics settings one to one', () => {
    for (const code of CHECK_CODES) {
      expect(settings[`qsp.diagnostics.${code}`], code).toBeDefined();
    }
    const booleanChecks = Object.entries(settings)
      .filter(([key, s]) => key.startsWith('qsp.diagnostics.') && s.type === 'boolean')
      .map(([key]) => key.slice('qsp.diagnostics.'.length));
    expect([...booleanChecks].sort()).toEqual(CHECK_CODES.filter(c => c !== 'maxLocationLines').sort());
    for (const code of OTHER_CODES) expect(SUPPRESSIBLE_CODES.has(code)).toBe(false);
  });

  describe('on diagnostics', () => {
    const parser = new QspTreeSitterParser();
    beforeAll(() => initParser(parser));

    it('every diagnostic has a code, and the name it is about', () => {
      const code = "# start\ngs 'нет_такой'\n*pl счёт\naddqst 'x.qsp'\n---\n# broken\nif x = 1\n---\n";
      const diags = runDiagnostics(parser, code, {
        unresolvedLocationRefs: true, uninitializedVariables: true, deprecatedBuiltins: true,
      });
      expect(diags.length).toBeGreaterThanOrEqual(4);
      for (const d of diags) expect(d.code, d.message).toBeTypeOf('string');
      const byCode = Object.fromEntries(diags.map(d => [d.code, d]));
      expect(byCode.unresolvedLocationRefs.data).toEqual({ name: 'нет_такой' });
      expect(byCode.uninitializedVariables.data).toEqual({ name: 'счёт' });
      expect(byCode.deprecatedBuiltins.data).toEqual({ name: 'addqst' });
      expect(byCode.syntax).toBeDefined();
    });

    it('turns the outdated-builtin warning off with its setting', () => {
      const diags = runDiagnostics(parser, "# start\naddqst 'x.qsp'\n---\n", { deprecatedBuiltins: false });
      expect(diags.filter(d => d.code === 'deprecatedBuiltins')).toEqual([]);
    });
  });
});
