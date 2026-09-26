// ── Performance log ──────────────────────────────────────────────────
//
// Times the analysis phases (parsing, symbols, project aggregates,
// diagnostics) and the memory around them, and writes one line per phase
// to the server log. The lines hold only counts, sizes, durations and
// memory, never file, location or variable names: users send them for
// games whose text they can't share.

/** Memory as the host sees it, in bytes. */
export interface MemorySample {
  heapUsed: number;
  /** The heap size at which the process dies with "JavaScript heap out of memory". */
  heapLimit?: number;
  rss?: number;
  /** Memory outside the JS heap: WASM (tree-sitter) and buffers. */
  external?: number;
}

export type MemoryReader = () => MemorySample;

/** Records CPU and heap profiles of the server (Node only; see nodeProfiler.ts). */
export interface Profiler {
  /** Start profiling into `dir`. */
  start(dir: string): void;
  /** Write the final profiles and stop; returns the names of this process's files. */
  stop(): Promise<string[]>;
  /** Append a phase line to the profile's log. */
  log(line: string): void;
  /** Whether profiling is on in this process. */
  readonly active: boolean;
  /** Write `data` as `<base>-<pid>.json` into the profile directory. */
  writeJson(base: string, data: unknown): void;
}

/** What only some hosts (the Node server) can offer the transport-agnostic server. */
export interface ServerHost {
  memory?: MemoryReader;
  profiler?: Profiler;
  /** The server's process id, which names its profile files. */
  processId?: number;
}

/** A phase at least this long is logged even without `qsp.debug.performanceLog`. */
export const SLOW_PHASE_MS = 1000;

const HEARTBEAT_MS = 1000;

// One per process: the profiler's sampler, set by PerfLog.onHeartbeat.
let heartbeatHook: (() => void) | undefined;
let lastBeat = 0;

/**
 * Let the profiler sample if a second has passed since it last did.
 * Cheap enough for hot loops: call it from loops that can run for long
 * inside one step (the project aggregates), which no timer interrupts.
 */
export function heartbeat(): void {
  if (!heartbeatHook) return;
  const now = performance.now();
  if (now - lastBeat < HEARTBEAT_MS) return;
  lastBeat = now;
  try {
    heartbeatHook();
  } catch {
    // Profiling must never break the analysis.
  }
}

interface StepTotal { ms: number; count: number }

const MB = 1024 * 1024;

function formatMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / MB)} MB`;
}

/** Collects phase timings and writes them to the log. */
export class PerfLog {
  /** Log every phase, not just the slow ones (`qsp.debug.performanceLog`). */
  verbose = false;
  private steps: Map<string, StepTotal> | undefined;
  private readonly sinks = new Set<(line: string) => void>();

  constructor(
    private readonly write: (line: string) => void,
    private readonly memory?: MemoryReader,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Also send every line to `sink` (the profiler's phase log), slow or not. */
  addSink(sink: (line: string) => void): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /**
   * Call `fn` at most every `intervalMs` while steps run. Long analyses
   * are synchronous loops that no timer interrupts; this is how the
   * profiler still samples the heap during them.
   */
  onHeartbeat(fn: (() => void) | undefined): void {
    heartbeatHook = fn;
    lastBeat = 0;
  }

  /** Current memory, or undefined where the host can't tell (the browser). */
  sampleMemory(): MemorySample | undefined {
    try {
      return this.memory?.();
    } catch {
      return undefined;
    }
  }

  /**
   * Run `fn` as the phase `name`: time it, break the time down by the
   * `step`s run inside it, and log it with the memory before and after.
   * `details` describes the work done, in numbers only. A phase inside
   * another also counts as a step of the outer one.
   */
  phase<T>(name: string, fn: () => T, details?: (result: T) => string): T {
    const outer = this.steps;
    this.steps = new Map();
    const before = this.sampleMemory();
    const started = this.now();
    let result: T | undefined;
    let failed = false;
    try {
      result = fn();
      return result;
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      const ms = this.now() - started;
      const steps = this.steps;
      this.steps = outer;
      if (outer) addStep(outer, name, ms);
      this.report(name, ms, steps, before, failed ? 'failed' : details ? safeDetails(details, result as T) : '');
    }
  }

  /** `phase` for async work. Steps run while it awaits count towards it. */
  async phaseAsync<T>(name: string, fn: () => Promise<T>, details?: (result: T) => string): Promise<T> {
    const outer = this.steps;
    const steps = new Map<string, StepTotal>();
    this.steps = steps;
    const before = this.sampleMemory();
    const started = this.now();
    let result: T | undefined;
    let failed = false;
    try {
      result = await fn();
      return result;
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      const ms = this.now() - started;
      this.steps = outer;
      if (outer) addStep(outer, name, ms);
      this.report(name, ms, steps, before, failed ? 'failed' : details ? safeDetails(details, result as T) : '');
    }
  }

  /** Add the time of `fn` to the enclosing phase's breakdown under `name`; just runs `fn` outside a phase. */
  step<T>(name: string, fn: () => T): T {
    const steps = this.steps;
    if (!steps) return fn();
    const started = this.now();
    try {
      return fn();
    } finally {
      addStep(steps, name, this.now() - started);
      heartbeat();
    }
  }

  /** Log a one-off line (e.g. a reply size), always. */
  note(text: string): void {
    this.emit(`[perf] ${text}`, true);
  }

  private report(name: string, ms: number, steps: Map<string, StepTotal>, before: MemorySample | undefined, details: string): void {
    const parts = [`[perf] ${name} ${formatMs(ms)}`];
    if (steps.size > 0) {
      const list = [...steps].sort((a, b) => b[1].ms - a[1].ms)
        .map(([step, t]) => `${step} ${formatMs(t.ms)}${t.count > 1 ? ` (${t.count}×)` : ''}`);
      parts.push(list.join(', '));
    }
    const after = this.sampleMemory();
    if (after) {
      const delta = before ? after.heapUsed - before.heapUsed : 0;
      let mem = `heap ${formatMb(after.heapUsed)}${before ? ` (${delta >= 0 ? '+' : '−'}${formatMb(Math.abs(delta))})` : ''}`;
      if (after.heapLimit) mem += ` of ${formatMb(after.heapLimit)}`;
      if (after.external !== undefined) mem += `, external ${formatMb(after.external)}`;
      if (after.rss !== undefined) mem += `, rss ${formatMb(after.rss)}`;
      parts.push(mem);
    }
    if (details) parts.push(details);
    this.emit(parts.join(' · '), this.verbose || ms >= SLOW_PHASE_MS);
  }

  private emit(line: string, toLog: boolean): void {
    if (toLog) this.write(line);
    for (const sink of this.sinks) sink(line);
  }
}

function addStep(steps: Map<string, StepTotal>, name: string, ms: number): void {
  const t = steps.get(name);
  if (t) {
    t.ms += ms;
    t.count++;
  } else {
    steps.set(name, { ms, count: 1 });
  }
}

// A details callback that throws must not hide the phase line (or replace
// the phase's own exception).
function safeDetails<T>(details: (result: T) => string, result: T): string {
  try {
    return details(result);
  } catch {
    return '';
  }
}

/** Human-readable size of a text, e.g. `25.5 M chars`. Used in phase details. */
export function formatChars(chars: number): string {
  return chars >= 1_000_000 ? `${(chars / 1_000_000).toFixed(1)} M chars` : chars >= 1000 ? `${Math.round(chars / 1000)} K chars` : `${chars} chars`;
}
