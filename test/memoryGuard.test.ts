/**
 * Reduced analysis when the server runs short of memory
 * (src/server/memoryGuard.ts, the stop hook of buildPropagatedLocals).
 *
 * Why
 * ───
 * - Running out of the ~4 GB heap kills the server; past 70% of the limit
 *   it drops the analysis it can do without instead.
 * - It stays reduced once it has switched: freeing the data makes the
 *   heap look fine, and redoing the work would fill it again.
 * - Stopped propagation must leave no half result, and the aggregates
 *   built alongside it (who writes `result`) must still be there.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { MemoryGuard } from '../src/server/memoryGuard';
import { buildFileAggregates } from '../src/server/aggregation';
import { describeAnalysisStatus } from '../src/common/analysisStatus';
import { initParser, parseAndExtract } from './testHelpers';

const MB = 1048576;

describe('MemoryGuard', () => {
  it('switches to reduced analysis once, past 70% of the heap limit, and stays there', () => {
    let used = 1000 * MB;
    const calls: number[] = [];
    const guard = new MemoryGuard(() => ({ heapUsed: used, heapLimit: 4096 * MB }), (u) => calls.push(u));
    expect(guard.tight()).toBe(false);
    used = 2900 * MB;
    expect(guard.tight()).toBe(true);
    used = 500 * MB;
    expect(guard.tight()).toBe(true);
    expect(guard.reduced).toBe(true);
    expect(calls).toEqual([2900 * MB]);
  });

  it('never trips without a memory reader (the browser)', () => {
    const guard = new MemoryGuard(undefined, () => { throw new Error('no'); });
    expect(guard.tight()).toBe(false);
  });
});

describe('buildPropagatedLocals stopped for memory', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  const code = [
    '# caller', 'local x = 1', "gs 'callee'", "y = func('fn')", '--- caller ---',
    '# callee', '*pl x', '--- callee ---',
    '# fn', 'result = 2', '--- fn ---', '',
  ].join('\n');

  it('drops the propagation but keeps the other aggregates', () => {
    const { symbols } = parseAndExtract(parser, code);
    const full = buildFileAggregates(symbols, 'file:///g.qsps');
    expect(full.propagatedLocals.get('callee')?.has('x')).toBe(true);

    const stopped = buildFileAggregates(symbols, 'file:///g.qsps', () => true);
    expect(stopped.propagatedLocals.size).toBe(0);
    expect(stopped.propagatedSyms.size).toBe(0);
    expect(stopped.locationsWritingResult.has('fn')).toBe(true);
  });
});

describe('describeAnalysisStatus: reduced analysis', () => {
  it('warns, with the heap it switched at', () => {
    const view = describeAnalysisStatus({ parser: 'full', busyUris: [], configured: true, reduced: { heapMB: 2950, limitMB: 4144 } }, undefined);
    expect(view).toMatchObject({ text: 'Reduced analysis', warning: true });
    expect(view.detail).toContain('2950 of 4144 MB');
  });
});
