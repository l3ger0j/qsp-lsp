// ── Work in slices ───────────────────────────────────────────────────
//
// The aggregates and diagnostics of a large game take seconds of
// synchronous work, and a Node server answers nothing while it runs. Such
// work is written as a generator: each `yield` marks a point where it may
// pause (after a location, a call edge, a file), and the server runs it a
// slice of a few milliseconds at a time, letting the requests that came in
// meanwhile be answered between slices. Tests and small callers run the
// same generator to the end at once.

/** Work done in steps; each `yield` is a point where it may pause. */
export type Steps<T = void> = Generator<void, T, undefined>;

/** Run `steps` to the end without pausing. */
export function runNow<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** How {@link runInSlices} paces the work. */
export interface SliceOptions {
  /** Run at least this long before pausing. */
  sliceMs: number;
  /** Let the event loop run: requests and notifications that came in are handled. */
  pause: () => Promise<void>;
  /** Asked after every pause: true drops the work where it stands. */
  cancelled?: () => boolean;
}

/**
 * Run `steps` a slice at a time. Resolves to the result, or to undefined
 * when `cancelled` stopped it: the generator is then closed (its `finally`
 * blocks run), so it must leave nothing half done behind it.
 */
export async function runInSlices<T>(steps: Steps<T>, options: SliceOptions): Promise<{ value: T } | undefined> {
  let sliceStarted = performance.now();
  try {
    for (;;) {
      const r = steps.next();
      if (r.done) return { value: r.value };
      if (performance.now() - sliceStarted < options.sliceMs) continue;
      await options.pause();
      if (options.cancelled?.()) return undefined;
      sliceStarted = performance.now();
    }
  } finally {
    steps.return(undefined as T);
  }
}

/** `steps`, adding the time its slices run (not the pauses between them) to `time.ms`. */
export function* timed<T>(steps: Steps<T>, time: { ms: number }): Steps<T> {
  try {
    for (;;) {
      const started = performance.now();
      let r: IteratorResult<void, T>;
      try {
        r = steps.next();
      } finally {
        time.ms += performance.now() - started;
      }
      if (r.done) return r.value;
      yield;
    }
  } finally {
    steps.return(undefined as T);
  }
}
