// ── Crash recorder (Node) ────────────────────────────────────────────
//
// Records the server into a directory all the time, lightly, so a crash
// leaves a report (src/client/crashReports.ts packs it). Per server
// process:
//   session-<pid>.json      when the run started
//   memory-<pid>.csv        heap and RSS about every second, the last
//                           10 minutes
//   breadcrumbs-<pid>.jsonl anomalies, each with where the analysis was:
//                           heap past 50/70/85% of its limit, heap
//                           growing fast on one location, the analysis
//                           stuck on one location
//   trail-<pid>.json        the last locations analysed, how long each
//                           took and how much heap it added
//   heap-near-limit-<pid>.heapprofile, heap-anomaly-<n>-<pid>.heapprofile
//                           what the heap was allocated by, at 85% of the
//                           limit and at the first fast-growth anomalies
//   report-<pid>.json       the performance report, from the main thread
//   clean-<pid>.json        the run ended normally: on the shutdown
//                           request, or on any process.exit but one
//                           after an uncaught exception
// A run that dies of "heap out of memory" can't write anything more, so
// everything is written as it goes. The clean mark is written at once
// and synchronously: the client kills a server that takes over two
// seconds to shut down, and a server whose editor went away exits right
// after the request, so waiting for the worker would leave runs that
// merely ended looking like crashes.
//
// The sampling runs in a worker thread attached to the main thread's
// inspector, whose requests interrupt the main thread even inside a long
// synchronous analysis. Where the analysis is comes through shared
// memory the main thread writes and the worker reads at any time.
// Nothing written holds a real file, location or variable name: those
// arrive as pseudonyms (pseudonyms.ts), except in names-<pid>.json,
// which the client keeps out of reports. Script paths in profiles are
// cut to the file name so they don't carry the user's home directory.

import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';
import { Worker } from 'worker_threads';
import type { MemorySample, Recorder, TrackedLocation } from './perfLog';

/** Heap and process memory of this Node process. */
export function nodeMemory(): MemorySample {
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, heapLimit: v8.getHeapStatistics().heap_size_limit, rss: m.rss, external: m.external };
}

interface CallFrame { url: string }
interface ProfileNode { callFrame: CallFrame; children?: ProfileNode[] | number[] }

/** Cut every script URL in a CPU or heap profile down to its file name (in place). */
export function stripProfilePaths(profile: { nodes?: ProfileNode[]; head?: ProfileNode }): void {
  const strip = (frame: CallFrame) => {
    if (frame.url) frame.url = frame.url.split(/[\\/]/).pop() ?? '';
  };
  if (profile.nodes) for (const n of profile.nodes) strip(n.callFrame);
  const stack: ProfileNode[] = profile.head ? [profile.head] : [];
  while (stack.length > 0) {
    const n = stack.pop()!;
    strip(n.callFrame);
    for (const c of n.children ?? []) if (typeof c === 'object') stack.push(c);
  }
}

// Slots of the shared Int32Array: ids of the current phase, step and
// file (index + 1 into the tables sent to the worker, 0 = none) and the
// current location's index (-1 = none).
const SLOT_PHASE = 0, SLOT_STEP = 1, SLOT_FILE = 2, SLOT_LOCATION = 3;

/** Settings the worker gets as `workerData`. */
interface WorkerSettings {
  dir: string;
  pid: number;
  heapLimit: number;
  shared: SharedArrayBuffer;
  growthBytes: number;
  stallMs: number;
}

/** Anomaly thresholds; the defaults suit real games, tests use smaller ones. */
export interface RecorderThresholds {
  /** Heap growth on one location and step that makes a breadcrumb (MB). */
  growthMb?: number;
  /** Time on one location and step that counts as stuck (ms). */
  stallMs?: number;
}

// Plain JavaScript run with `eval: true`, so it needs no bundle of its own.
const WORKER_SOURCE = `
const fs = require('fs');
const path = require('path');
const { Session } = require('inspector');
const { parentPort, workerData } = require('worker_threads');
const stripProfilePaths = ${stripProfilePaths.toString()};
const { dir, pid, heapLimit, shared, growthBytes, stallMs } = workerData;
const where = new Int32Array(shared);
const file = (base, ext) => path.join(dir, base + '-' + pid + '.' + ext);
const session = new Session();
session.connectToMainThread();
const post = (method, params) => new Promise((resolve, reject) =>
  session.post(method, params || {}, (err, res) => (err ? reject(err) : resolve(res))));
const write = (base, ext, data) => fs.writeFileSync(file(base, ext), JSON.stringify(data));
const started = Date.now();
const seconds = () => Math.round((Date.now() - started) / 100) / 10;
const mb = (b) => Math.round(b / 1048576);

const names = { phase: [], step: [] };
const files = [];
let stopping = false;

// ── Where the analysis is ──
function context() {
  const phase = names.phase[Atomics.load(where, ${SLOT_PHASE}) - 1];
  const step = names.step[Atomics.load(where, ${SLOT_STEP}) - 1];
  const f = files[Atomics.load(where, ${SLOT_FILE}) - 1];
  const index = Atomics.load(where, ${SLOT_LOCATION});
  const location = f && index >= 0 ? f.locations[index] : undefined;
  return { phase, step, file: f ? f.id : undefined, location, locationIndex: f ? index : -1, key: (f ? f.id : '') + ':' + index + ':' + (step || '') };
}

parentPort.on('message', (msg) => {
  if (msg && msg.type === 'names') names[msg.kind] = msg.names;
  else if (msg && msg.type === 'file') files[msg.index] = { id: msg.id, locations: msg.locations };
  else if (msg === 'stop') stop();
});

// ── Breadcrumbs ──
let heapSnapshots = 0;
async function heapProfile(base) {
  const { profile } = await post('HeapProfiler.getSamplingProfile');
  stripProfilePaths(profile);
  write(base, 'heapprofile', profile);
}
function crumb(kind, usedSize, ctx, extra) {
  const line = Object.assign({ t: seconds(), kind, heapMB: mb(usedSize), limitMB: mb(heapLimit), rssMB: mb(process.memoryUsage().rss),
    phase: ctx.phase, step: ctx.step, file: ctx.file, location: ctx.location }, extra);
  fs.appendFileSync(file('breadcrumbs', 'jsonl'), JSON.stringify(line) + '\\n');
}

// Where each location's time and heap went, most recent last.
const trail = [];
let current;   // { key, since, heapAt, location, reportedGrowth, lastStall }
const thresholds = [0.5, 0.7, 0.85];
let passed = 0;

async function observe(usedSize) {
  const ctx = context();
  if (!current || current.key !== ctx.key) {
    if (current && current.location) {
      trail.push({ location: current.location.id, step: current.step, seconds: Math.round((Date.now() - current.since) / 100) / 10, heapMB: mb(usedSize - current.heapAt) });
      if (trail.length > 50) trail.shift();
    }
    current = { key: ctx.key, since: Date.now(), heapAt: usedSize, location: ctx.location, step: ctx.step, reportedGrowth: 0, lastStall: 0 };
  }
  while (passed < thresholds.length && usedSize >= thresholds[passed] * heapLimit) {
    crumb('heap-threshold', usedSize, ctx, { percent: Math.round(thresholds[passed] * 100) });
    if (thresholds[passed] >= 0.85) await heapProfile('heap-near-limit');
    passed++;
  }
  // Fast growth while the analysis stays on one location and step.
  const growth = usedSize - current.heapAt;
  if (growth - current.reportedGrowth >= growthBytes) {
    current.reportedGrowth = growth;
    crumb('heap-growth', usedSize, ctx, { growthMB: mb(growth), inContextSeconds: Math.round((Date.now() - current.since) / 100) / 10 });
    if (heapSnapshots < 3) await heapProfile('heap-anomaly-' + ++heapSnapshots);
  }
  // Stuck: stallMs on one location and step, then every 3 × stallMs more.
  const stuck = Date.now() - current.since;
  if ((ctx.location || ctx.step) && stuck >= stallMs && stuck - current.lastStall >= (current.lastStall ? 3 * stallMs : stallMs)) {
    current.lastStall = stuck;
    crumb('stall', usedSize, ctx, { inContextSeconds: Math.round(stuck / 100) / 10, growthMB: mb(growth) });
  }
}

// ── Sampling loop ──
const memoryRows = [];
function saveMemory() {
  fs.writeFileSync(file('memory', 'csv'), 'seconds,heapUsedMB,heapLimitMB,rssMB\\n' + memoryRows.join('\\n') + '\\n');
}
function saveTrail() { write('trail', 'json', { current: current && current.location ? { location: current.location.id, step: current.step, seconds: Math.round((Date.now() - current.since) / 100) / 10 } : undefined, recent: trail }); }

async function run() {
  write('session', 'json', { startedAt: new Date(started).toISOString(), heapLimitMB: mb(heapLimit) });
  // One sample per 512 KB allocated costs next to nothing and is enough
  // to see which code owns a heap of gigabytes.
  await post('HeapProfiler.startSampling', { samplingInterval: 524288 });
  let lastSave = 0;
  while (!stopping) {
    // Each request waits for the main thread to take an interrupt, so
    // samples are about a second apart but not exactly.
    const { usedSize } = await post('Runtime.getHeapUsage');
    memoryRows.push(seconds() + ',' + mb(usedSize) + ',' + mb(heapLimit) + ',' + mb(process.memoryUsage().rss));
    if (memoryRows.length > 600) memoryRows.shift();
    await observe(usedSize);
    if (Date.now() - lastSave >= 5000) { lastSave = Date.now(); saveMemory(); saveTrail(); }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

const running = run().catch((e) => fs.appendFileSync(file('breadcrumbs', 'jsonl'), JSON.stringify({ t: seconds(), kind: 'recorder-failed', error: String(e) }) + '\\n'));
async function stop() {
  stopping = true;
  await running;
  try {
    saveMemory();
    saveTrail();
    await post('HeapProfiler.stopSampling');
  } catch (e) { /* keep what was written */ }
  write('clean', 'json', { endedAt: new Date().toISOString() });
  session.disconnect();
  parentPort.postMessage('stopped');
}
`;

/**
 * One line of a stack trace with its script path cut to the file name:
 * `at fn (C:\Users\me\out\server\nodeMain.js:1:2)` → `fn (nodeMain.js:1:2)`.
 */
export function stackFrame(line: string): string {
  const m = /^\s*at (?:(.*?) \((.*)\)|(.*))$/.exec(line);
  if (!m) return '';
  const where = (m[2] ?? m[3] ?? '').split(/[\\/]/).pop() ?? '';
  return m[1] ? `${m[1]} (${where})` : where;
}

/** Recorder that samples the main thread from a worker thread. */
export class NodeRecorder implements Recorder {
  private worker: Worker | undefined;
  private dir = '';
  private where: Int32Array | undefined;
  private readonly ids = { phase: new Map<string, number>(), step: new Map<string, number>() };
  private files = 0;
  private uncaught = false;
  private readonly onExit = () => {
    if (!this.uncaught) this.markClean();
  };
  private readonly onUncaught = (e: unknown) => {
    this.uncaught = true;
    this.uncaughtCrumb(e);
  };

  constructor(private readonly thresholds: RecorderThresholds = {}) {}

  get active(): boolean {
    return this.worker !== undefined;
  }

  start(dir: string): void {
    if (this.worker) return;
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    const shared = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
    this.where = new Int32Array(shared);
    this.where[SLOT_LOCATION] = -1;
    const settings: WorkerSettings = {
      dir, pid: process.pid, heapLimit: v8.getHeapStatistics().heap_size_limit, shared,
      growthBytes: (this.thresholds.growthMb ?? 256) * 1048576,
      stallMs: this.thresholds.stallMs ?? 10_000,
    };
    this.worker = new Worker(WORKER_SOURCE, { eval: true, workerData: settings });
    // The server exits on the client's request whatever the recorder is doing.
    this.worker.unref();
    process.on('exit', this.onExit);
    process.on('uncaughtExceptionMonitor', this.onUncaught);
  }

  async stop(): Promise<string[]> {
    const worker = this.worker;
    if (!worker) return [];
    this.markClean();
    this.worker = undefined;
    process.off('exit', this.onExit);
    process.off('uncaughtExceptionMonitor', this.onUncaught);
    await new Promise<void>((resolve) => {
      // Shorter than the client's patience with a shutdown request.
      const timer = setTimeout(resolve, 1_500);
      worker.once('message', () => { clearTimeout(timer); resolve(); });
      worker.postMessage('stop');
    });
    await worker.terminate();
    return fs.readdirSync(this.dir).filter(f => f.includes(`-${process.pid}.`));
  }

  phase(name: string | undefined): void {
    this.setName('phase', SLOT_PHASE, name);
  }

  step(name: string | undefined): void {
    this.setName('step', SLOT_STEP, name);
  }

  file(id: string | undefined, locations?: readonly TrackedLocation[]): void {
    if (!this.where) return;
    if (id === undefined) {
      Atomics.store(this.where, SLOT_FILE, 0);
      Atomics.store(this.where, SLOT_LOCATION, -1);
      return;
    }
    // Sent before the slot changes, so the worker knows the table by the
    // time it reads the new id. Messages reach it even while this thread
    // stays busy in the analysis.
    const index = this.files++;
    this.worker?.postMessage({ type: 'file', index, id, locations });
    Atomics.store(this.where, SLOT_LOCATION, -1);
    Atomics.store(this.where, SLOT_FILE, index + 1);
  }

  location(index: number): void {
    if (this.where) Atomics.store(this.where, SLOT_LOCATION, index);
  }

  writeJson(base: string, data: unknown): void {
    if (!this.worker) return;
    fs.writeFileSync(this.pathFor(base, 'json'), JSON.stringify(data, null, 2));
  }

  private setName(kind: 'phase' | 'step', slot: number, name: string | undefined): void {
    if (!this.where) return;
    let id = 0;
    if (name !== undefined) {
      const ids = this.ids[kind];
      id = ids.get(name) ?? 0;
      if (id === 0) {
        id = ids.size + 1;
        ids.set(name, id);
        this.worker?.postMessage({ type: 'names', kind, names: [...ids.keys()] });
      }
    }
    Atomics.store(this.where, slot, id);
  }

  private markClean(): void {
    try {
      fs.writeFileSync(this.pathFor('clean', 'json'), JSON.stringify({ endedAt: new Date().toISOString() }));
    } catch {
      // The directory is gone; nothing to report from then.
    }
  }

  // The error's message may quote the game, so only its type and the
  // extension's own frames go in.
  private uncaughtCrumb(e: unknown): void {
    const error = e instanceof Error ? e : undefined;
    const frames = (error?.stack ?? '').split('\n').slice(1, 11).map(stackFrame);
    try {
      fs.appendFileSync(this.pathFor('breadcrumbs', 'jsonl'), `${JSON.stringify({ kind: 'uncaught-exception', error: error?.name ?? typeof e, frames })}\n`);
    } catch {
      // Nowhere to write.
    }
  }

  private pathFor(base: string, ext: string): string {
    return path.join(this.dir, `${base}-${process.pid}.${ext}`);
  }
}
