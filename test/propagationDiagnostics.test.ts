/**
 * Call-site lists in propagation diagnostics
 * (src/server/diagnosticPasses/propagationDiagnostics.ts).
 *
 * Why
 * ───
 * - The "propagated as local from … but not from …" message is repeated
 *   at every reference to the variable. Listing every call site made
 *   messages of hundreds of kilobytes in large games, and the heap and
 *   the protocol carried all of them; the first few say enough.
 */
import { describe, it, expect } from 'vitest';
import { formatCallSiteGroups } from '../src/server/diagnosticPasses/propagationDiagnostics';

const site = (callerName: string, line: number) => ({
  callerName, ref: { uri: 'file:///g.qsps', line: line - 1, column: 0, endLine: line - 1, endColumn: 1 },
});

describe('formatCallSiteGroups', () => {
  it('groups lines by caller, in order of their first line', () => {
    expect(formatCallSiteGroups([site('b', 9), site('a', 3), site('a', 5)])).toBe('a lines 3, 5, b line 9');
  });

  it('lists the first few callers and lines, and counts the rest', () => {
    const sites = [
      ...Array.from({ length: 8 }, (_, i) => site('hub', 10 + i)),
      ...Array.from({ length: 7 }, (_, i) => site(`room${i}`, 100 + i)),
    ];
    expect(formatCallSiteGroups(sites)).toBe(
      'hub lines 10, 11, 12, 13, 14 and 3 more, room0 line 100, room1 line 101, room2 line 102, room3 line 103 and 3 more locations',
    );
  });
});
