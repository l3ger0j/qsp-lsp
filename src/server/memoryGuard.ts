// ── Memory guard ─────────────────────────────────────────────────────
//
// VS Code's runtime caps the server's heap near 4 GB, and running out of
// it kills the server. Past REDUCED_ANALYSIS_SHARE of the limit the
// server drops the analysis it can do without (propagated locals and the
// checks built on them, cached semantic tokens of large files) and says
// so in the status item, instead of crashing. It stays reduced until the
// server restarts: dropping the data frees memory, and redoing the work
// once the heap looks fine again would only fill it up again.

import type { MemoryReader } from './perfLog';

/** The share of the heap limit past which optional analysis stops. */
export const REDUCED_ANALYSIS_SHARE = 0.7;

/** Watches the heap and switches the server to reduced analysis once. */
export class MemoryGuard {
  private reducedSince: number | undefined;

  constructor(
    private readonly read: MemoryReader | undefined,
    /** Called once, when reduced analysis starts, with the heap then (bytes). */
    private readonly onReduce: (heapUsed: number, heapLimit: number) => void,
  ) {}

  /** Whether the server has switched to reduced analysis. */
  get reduced(): boolean {
    return this.reducedSince !== undefined;
  }

  /**
   * Whether optional analysis should be skipped now: once the heap has
   * passed the threshold, always. Cheap enough to ask per location or
   * per call edge.
   */
  tight(): boolean {
    if (this.reducedSince !== undefined) return true;
    let m;
    try {
      m = this.read?.();
    } catch {
      return false;
    }
    if (!m?.heapLimit || m.heapUsed < REDUCED_ANALYSIS_SHARE * m.heapLimit) return false;
    this.reducedSince = Date.now();
    this.onReduce(m.heapUsed, m.heapLimit);
    return true;
  }
}
