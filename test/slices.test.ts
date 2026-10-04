/**
 * Work in slices (src/server/slices.ts).
 *
 * Why
 * ───
 * The aggregates and diagnostics of a large game take seconds, and a Node
 * server answers nothing while synchronous work runs. They are written as
 * generators the server runs a slice at a time, so requests are answered
 * between slices; a run a later one replaces must stop cleanly, and the
 * same generator run at once (tests, small callers) must give the same
 * result.
 */
import { describe, it, expect } from 'vitest';
import { runInSlices, runNow, timed, type Steps } from '../src/server/slices';

function* count(to: number, log: string[] = []): Steps<number> {
  try {
    let sum = 0;
    for (let i = 1; i <= to; i++) {
      sum += i;
      yield;
    }
    return sum;
  } finally {
    log.push('closed');
  }
}

describe('slices', () => {
  it('run to the end at once or in slices with the same result', async () => {
    expect(runNow(count(10))).toBe(55);
    let pauses = 0;
    const done = await runInSlices(count(10), { sliceMs: 0, pause: async () => { pauses++; } });
    expect(done).toEqual({ value: 55 });
    expect(pauses).toBe(10);
  });

  it('let the event loop run between slices', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    function* busy(): Steps {
      // Long enough for several slices of 5 ms.
      const until = performance.now() + 40;
      while (performance.now() < until) yield;
    }
    await runInSlices(busy(), { sliceMs: 5, pause: () => new Promise(r => setTimeout(r, 0)) });
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });

  it('stop when cancelled, closing the work', async () => {
    const log: string[] = [];
    let pauses = 0;
    const done = await runInSlices(count(10, log), { sliceMs: 0, pause: async () => { pauses++; }, cancelled: () => pauses >= 3 });
    expect(done).toBeUndefined();
    expect(pauses).toBe(3);
    expect(log).toEqual(['closed']);
  });

  it('time the slices only, not the pauses between them', async () => {
    const time = { ms: 0 };
    function* sleepy(): Steps {
      yield;
      yield;
    }
    const started = performance.now();
    await runInSlices(timed(sleepy(), time), { sliceMs: 0, pause: () => new Promise(r => setTimeout(r, 30)) });
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
    expect(time.ms).toBeLessThan(20);
  });
});
