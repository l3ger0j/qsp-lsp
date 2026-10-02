/**
 * The per-file limit on diagnostics (DiagnosticCtx.results).
 *
 * Why
 * ───
 * - A 1000-location game made 718 000 diagnostics in one file: a message
 *   the editor can't show and the protocol takes minutes to carry. With
 *   `qsp.diagnostics.maxPerFile` set, the most severe that many are kept,
 *   in order, and one note says how many more there were.
 */
import { describe, it, expect } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { DiagnosticCtx } from '../src/server/diagnosticPasses/diagnosticHelpers';
import type { DiagnosticSettings } from '../src/server/diagnostics';

function ctxWith(maxPerFile: number): DiagnosticCtx {
  const ctx = new DiagnosticCtx(null, { maxPerFile } as DiagnosticSettings);
  const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 1 } });
  ctx.push(DiagnosticSeverity.Hint, at(0), 'hint 1', { code: 'syntax' });
  ctx.push(DiagnosticSeverity.Warning, at(1), 'warning 1', { code: 'syntax' });
  ctx.push(DiagnosticSeverity.Hint, at(2), 'hint 2', { code: 'syntax' });
  ctx.push(DiagnosticSeverity.Error, at(3), 'error 1', { code: 'syntax' });
  ctx.push(DiagnosticSeverity.Warning, at(4), 'warning 2', { code: 'syntax' });
  return ctx;
}

describe('DiagnosticCtx.results', () => {
  it('keeps the most severe up to the limit and notes the rest', () => {
    const out = ctxWith(3).results();
    expect(out.map(d => d.message)).toEqual([
      'error 1', 'warning 1', 'warning 2',
      '2 more problems in this file are not shown (qsp.diagnostics.maxPerFile is 3); the most severe come first',
    ]);
  });

  it('returns everything within the limit, or with no limit', () => {
    expect(ctxWith(5).results()).toHaveLength(5);
    expect(ctxWith(0).results()).toHaveLength(5);
  });
});
