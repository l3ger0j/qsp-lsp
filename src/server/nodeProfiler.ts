// ── Server profiler (Node) ───────────────────────────────────────────
//
// "QSP: Collect Performance Profile" restarts the server with a profile
// directory; this records into it, per server process:
//   memory-<pid>.csv               heap and RSS every second
//   heap-latest-<pid>.heapprofile  what the live heap was allocated by,
//                                  rewritten every 10 s
//   heap-near-limit-<pid>.heapprofile  the same, once, when the heap
//                                  first passes 85% of its limit
//   cpu-latest-<pid>.cpuprofile    where the time went in the last 30 s
//   cpu-<pid>.cpuprofile, heap-<pid>.heapprofile  written on save
//   phases-<pid>.log, report-<pid>.json  (from the main thread)
// A game that runs out of memory kills the process, so everything is
// written as it goes: the crashed runs keep the picture from just before.
//
// The sampling runs in a worker thread connected to the main thread's
// inspector. Inspector requests interrupt the main thread even inside a
// long synchronous loop (an analysis that never yields), which a timer
// or a sampler on the main thread can't. Profiles hold the extension's
// own function names; script paths are cut to the file name so they
// don't carry the user's home directory.

import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';
import { Worker } from 'worker_threads';
import type { MemorySample, Profiler } from './perfLog';

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

/** Settings the sampling worker gets as `workerData`. */
interface WorkerSettings { dir: string; pid: number; heapLimit: number }

// Plain JavaScript run with `eval: true`, so it needs no bundle of its own.
const WORKER_SOURCE = `
const fs = require('fs');
const path = require('path');
const { Session } = require('inspector');
const { parentPort, workerData } = require('worker_threads');
const stripProfilePaths = ${stripProfilePaths.toString()};
const { dir, pid, heapLimit } = workerData;
const file = (base, ext) => path.join(dir, base + '-' + pid + '.' + ext);
const session = new Session();
session.connectToMainThread();
const post = (method, params) => new Promise((resolve, reject) =>
  session.post(method, params || {}, (err, res) => (err ? reject(err) : resolve(res))));
const write = (base, ext, data) => fs.writeFileSync(file(base, ext), JSON.stringify(data));
const started = Date.now();
let stopping = false;
let nearLimitSaved = false;

async function heapProfile(base) {
  const { profile } = await post('HeapProfiler.getSamplingProfile');
  stripProfilePaths(profile);
  write(base, 'heapprofile', profile);
}
async function cpuProfile(base, restart) {
  const { profile } = await post('Profiler.stop');
  stripProfilePaths(profile);
  write(base, 'cpuprofile', profile);
  if (restart) await post('Profiler.start');
}

async function run() {
  fs.writeFileSync(file('memory', 'csv'), 'seconds,heapUsedMB,heapLimitMB,rssMB\\n');
  await post('HeapProfiler.startSampling', { samplingInterval: 65536 });
  await post('Profiler.enable');
  await post('Profiler.start');
  let lastHeap = Date.now(), lastCpu = Date.now();
  while (!stopping) {
    // Each request waits for the main thread to take an interrupt, so
    // the rows are about a second apart but not exactly.
    const { usedSize } = await post('Runtime.getHeapUsage');
    const mb = (b) => (b / 1048576).toFixed(0);
    fs.appendFileSync(file('memory', 'csv'),
      ((Date.now() - started) / 1000).toFixed(1) + ',' + mb(usedSize) + ',' + mb(heapLimit) + ',' + mb(process.memoryUsage().rss) + '\\n');
    if (!nearLimitSaved && usedSize > 0.85 * heapLimit) {
      nearLimitSaved = true;
      await heapProfile('heap-near-limit');
    }
    if (Date.now() - lastHeap >= 10000) { lastHeap = Date.now(); await heapProfile('heap-latest'); }
    if (Date.now() - lastCpu >= 30000) { lastCpu = Date.now(); await cpuProfile('cpu-latest', true); }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

const running = run().catch((e) => fs.appendFileSync(file('memory', 'csv'), '# sampler failed: ' + e + '\\n'));
parentPort.on('message', async (msg) => {
  if (msg !== 'stop') return;
  stopping = true;
  await running;
  try {
    await cpuProfile('cpu', false);
    await heapProfile('heap');
    await post('HeapProfiler.stopSampling');
  } catch (e) { /* report what was written */ }
  session.disconnect();
  parentPort.postMessage('stopped');
});
`;

/** Profiler that samples the main thread from a worker thread. */
export class NodeProfiler implements Profiler {
  private worker: Worker | undefined;
  private dir = '';

  get active(): boolean {
    return this.worker !== undefined;
  }

  start(dir: string): void {
    if (this.worker) return;
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    const settings: WorkerSettings = { dir, pid: process.pid, heapLimit: v8.getHeapStatistics().heap_size_limit };
    this.worker = new Worker(WORKER_SOURCE, { eval: true, workerData: settings });
    // The server exits on the client's request whatever the sampler is doing.
    this.worker.unref();
  }

  async stop(): Promise<string[]> {
    const worker = this.worker;
    if (!worker) return [];
    this.worker = undefined;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 15_000);
      worker.once('message', () => { clearTimeout(timer); resolve(); });
      worker.postMessage('stop');
    });
    await worker.terminate();
    return fs.readdirSync(this.dir).filter(f => f.includes(`-${process.pid}.`));
  }

  log(line: string): void {
    if (!this.worker) return;
    fs.appendFileSync(this.file('phases', 'log'), `${new Date().toISOString()} ${line}\n`);
  }

  writeJson(base: string, data: unknown): void {
    if (!this.worker) return;
    fs.writeFileSync(this.file(base, 'json'), JSON.stringify(data, null, 2));
  }

  private file(base: string, ext: string): string {
    return path.join(this.dir, `${base}-${process.pid}.${ext}`);
  }
}
