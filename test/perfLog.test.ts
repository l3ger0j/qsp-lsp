/**
 * The performance log (src/server/perfLog.ts).
 *
 * Why
 * ───
 * - Users send these lines for games whose text they can't share, so a
 *   phase's breakdown and memory must be in the line itself.
 * - Fast phases stay out of the log unless asked for, or every keystroke
 *   would add lines; slow ones are logged always.
 * - The heartbeat is how the profiler samples the heap inside long
 *   synchronous analyses that no timer can interrupt.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PerfLog, SLOW_PHASE_MS, formatChars, heartbeat } from '../src/server/perfLog';

function fixture(heap = [100, 300]) {
  let clock = 0;
  let mem = 0;
  const lines: string[] = [];
  const perf = new PerfLog(
    (l) => lines.push(l),
    () => ({ heapUsed: heap[Math.min(mem++, heap.length - 1)] * 1048576, heapLimit: 4096 * 1048576, rss: 900 * 1048576 }),
    () => clock,
  );
  return { perf, lines, advance: (ms: number) => { clock += ms; } };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('PerfLog', () => {
  it('logs a slow phase with its steps, memory and details', () => {
    const { perf, lines, advance } = fixture();
    const n = perf.phase('per-location analysis', () => {
      for (let i = 0; i < 3; i++) perf.step('parse', () => advance(400));
      perf.step('symbols', () => advance(300));
      return 3;
    }, (count) => `${count} locations`);
    expect(n).toBe(3);
    expect(lines).toEqual([
      '[perf] per-location analysis 1.50 s · parse 1.20 s (3×), symbols 300 ms · heap 300 MB (+200 MB) of 4096 MB, rss 900 MB · 3 locations',
    ]);
  });

  it('keeps fast phases out of the log unless verbose, but always sends them to sinks', () => {
    const { perf, lines, advance } = fixture();
    const sunk: string[] = [];
    perf.addSink((l) => sunk.push(l));
    perf.phase('location update', () => advance(SLOW_PHASE_MS - 1));
    expect(lines).toEqual([]);
    expect(sunk).toHaveLength(1);
    perf.verbose = true;
    perf.phase('location update', () => advance(5));
    expect(lines).toHaveLength(1);
  });

  it('counts a nested phase as a step of the outer one', () => {
    const { perf, lines, advance } = fixture();
    perf.verbose = true;
    perf.phase('project load', () => {
      perf.phase('project aggregates', () => advance(1200));
      perf.step('parse', () => advance(100));
    });
    expect(lines[0]).toMatch(/^\[perf\] project aggregates 1\.20 s/);
    expect(lines[1]).toMatch(/^\[perf\] project load 1\.30 s · project aggregates 1\.20 s, parse 100 ms/);
  });

  it('still logs a phase that throws, and rethrows', () => {
    const { perf, lines, advance } = fixture();
    expect(() => perf.phase('whole-file analysis', () => { advance(2000); throw new Error('boom'); })).toThrow('boom');
    expect(lines[0]).toMatch(/whole-file analysis 2\.00 s .* failed$/);
  });

  it('times async phases', async () => {
    const { perf, lines, advance } = fixture();
    await perf.phaseAsync('project load', async () => {
      await Promise.resolve();
      perf.step('read', () => advance(1500));
    }, () => '12 files');
    expect(lines[0]).toMatch(/^\[perf\] project load 1\.50 s · read 1\.50 s · .* · 12 files$/);
  });

  it('works without a memory reader (the browser)', () => {
    const lines: string[] = [];
    const perf = new PerfLog((l) => lines.push(l), undefined, () => 0);
    perf.verbose = true;
    perf.phase('semantic tokens', () => 1);
    expect(lines).toEqual(['[perf] semantic tokens 0 ms']);
  });

  it('beats the heartbeat at most once a second, from steps and from hot loops', () => {
    // The heartbeat is process-wide and reads the real clock.
    let now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { perf } = fixture();
    let beats = 0;
    perf.onHeartbeat(() => { beats++; });
    perf.phase('per-location analysis', () => {
      for (let i = 0; i < 30; i++) perf.step('parse', () => { now += 100; });
    });
    expect(beats).toBe(3);
    for (let i = 0; i < 25; i++) { now += 100; heartbeat(); }
    expect(beats).toBe(6);
    perf.onHeartbeat(undefined);
  });

  it('formats text sizes', () => {
    expect(formatChars(25_546_224)).toBe('25.5 M chars');
    expect(formatChars(4_200)).toBe('4 K chars');
    expect(formatChars(12)).toBe('12 chars');
  });
});
