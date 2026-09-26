#!/usr/bin/env node
// ── Language server load test ────────────────────────────────────────
//
// Starts the built language server (out/server/nodeMain.js) on a project
// the way VS Code does (stdio, project mode, one file open) and reports
// how long the analysis takes and how much memory it uses. Pair it with
// scripts/stress/genGame.mjs.
//
//   node scripts/stress/bench.mjs <project dir> [--open <file>] [--graph]
//       [--edits N] [--heap-mb N] [--timeout S] [--json <out.json>]
//       [--max-seconds S] [--max-heap-mb N]
//
// --open     file to open like an editor tab (default: the largest one;
//            "none" opens nothing)
// --graph    also ask for the jump graph and report its size
// --edits N  then type N characters into the open file, reporting how
//            long each takes to be re-diagnosed
// --heap-mb  the server's heap limit (Node's default otherwise)
// --crash    directory for the always-on crash recorder, as the extension
//            passes it (breadcrumbs, memory, trail, report)
// --max-seconds / --max-heap-mb  exit with code 1 when exceeded (budgets)

import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    out[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const project = args._[0] && path.resolve(args._[0]);
if (!project || !fs.existsSync(project)) {
  console.error('usage: bench.mjs <project dir> [--open <file>|none] [--graph] [--edits N] [--heap-mb N] [--crash <dir>] [--timeout S] [--json out.json] [--max-seconds S] [--max-heap-mb N]');
  process.exit(2);
}
const server = path.join(root, 'out', 'server', 'nodeMain.js');
if (!fs.existsSync(server)) {
  console.error(`${server} is missing: run npm run build:server:node first`);
  process.exit(2);
}

const qspFiles = fs.readdirSync(project, { recursive: true })
  .map(f => path.join(project, String(f)))
  .filter(f => /\.(qsps|qsrc)$/i.test(f));
let openFile;
if (args.open !== 'none') {
  openFile = args.open ? path.resolve(project, args.open) : qspFiles.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
}

// ── Server process and memory ────────────────────────────────────────

const nodeArgs = args['heap-mb'] ? [`--max-old-space-size=${args['heap-mb']}`] : [];
const child = spawn(process.execPath, [...nodeArgs, server, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
const t0 = Date.now();
const elapsed = () => (Date.now() - t0) / 1000;
let peakRssMb = 0;
// `ps` gives the child's RSS on Linux and macOS; on Windows only the
// server's own report (at the end) has memory figures.
const canPs = process.platform !== 'win32';
const memTimer = setInterval(() => {
  if (!canPs) return;
  try {
    const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)]).toString().trim());
    if (kb > 0) peakRssMb = Math.max(peakRssMb, kb / 1024);
  } catch { /* the process is gone */ }
}, 500);
let stderr = '';
child.stderr.on('data', d => { stderr += d; });

// ── LSP over stdio ───────────────────────────────────────────────────

let nextId = 1;
const pending = new Map();
function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}
function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const perfLines = [];
const listeners = new Set();
let buf = Buffer.alloc(0);
child.stdout.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const head = buf.indexOf('\r\n\r\n');
    if (head < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, head).toString())[1]);
    if (buf.length < head + 4 + len) return;
    const msg = JSON.parse(buf.subarray(head + 4, head + 4 + len).toString());
    buf = buf.subarray(head + 4 + len);
    onMessage(msg);
  }
});

function onMessage(msg) {
  if (msg.id !== undefined && msg.method) {
    // Requests from the server: settings, capability registration.
    let result = null;
    if (msg.method === 'workspace/configuration') {
      result = msg.params.items.map(item => (item.section === 'qsp' ? { debug: { performanceLog: true } } : {}));
    }
    send({ id: msg.id, result });
    return;
  }
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.reject(new Error(msg.error.message)); else p?.resolve(msg.result);
    return;
  }
  if (msg.method === 'window/logMessage' && msg.params.message.includes('[perf]')) {
    perfLines.push(`${elapsed().toFixed(1).padStart(6)}s ${msg.params.message}`);
    console.log(perfLines.at(-1));
  }
  for (const l of listeners) l(msg);
}

function waitFor(pred, timeoutS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(l); reject(new Error(`timed out after ${timeoutS} s`)); }, timeoutS * 1000);
    const l = msg => {
      const v = pred(msg);
      if (v) { clearTimeout(timer); listeners.delete(l); resolve(v); }
    };
    listeners.add(l);
  });
}

// ── The run ──────────────────────────────────────────────────────────

const timeoutS = Number(args.timeout ?? 900);
const results = { project: path.basename(project), files: qspFiles.length, chars: 0, openFile: openFile && path.basename(openFile) };
// A crash out of memory aborts the process: no exit code, a signal.
child.on('exit', (code, signal) => {
  if (results.done) return;
  console.error(`\nserver exited (${signal ?? `code ${code}`}) after ${elapsed().toFixed(1)} s`);
  const oom = /heap out of memory/i.test(stderr);
  if (oom) console.error('JavaScript heap out of memory');
  results.crashed = { code, signal, seconds: elapsed(), outOfMemory: oom };
  finish(1);
});

const openUri = openFile && pathToFileURL(openFile).href;
const projectUri = pathToFileURL(project).href;

await request('initialize', {
  processId: process.pid,
  rootUri: projectUri,
  workspaceFolders: [{ uri: projectUri, name: path.basename(project) }],
  capabilities: { workspace: { configuration: true, workspaceFolders: true } },
  initializationOptions: args.crash ? { crashDir: path.resolve(args.crash) } : undefined,
});
send({ method: 'initialized', params: {} });

const firstDiagnostics = openUri
  ? waitFor(m => m.method === 'textDocument/publishDiagnostics' && m.params.uri === openUri && elapsed(), timeoutS)
  : Promise.resolve(undefined);
let openText;
if (openFile) {
  openText = fs.readFileSync(openFile, 'utf8');
  send({ method: 'textDocument/didOpen', params: { textDocument: { uri: openUri, languageId: 'qsp', version: 1, text: openText } } });
}
for (const f of qspFiles) results.chars += fs.statSync(f).size;

try {
  results.firstDiagnosticsSeconds = await firstDiagnostics;
  results.readySeconds = await waitFor(m => m.method === 'qsp/analysisStatus'
    && m.params.configured && m.params.busyUris.length === 0 && m.params.parser !== 'starting'
    && (!m.params.project || m.params.project.state === 'ready') && elapsed(), timeoutS);
  console.log(`\nready after ${results.readySeconds.toFixed(1)} s`);

  if (args.graph) {
    const started = Date.now();
    const graph = await request('qsp/jumpGraph', { uri: projectUri });
    results.graph = {
      seconds: (Date.now() - started) / 1000,
      nodes: graph.nodes.length, edges: graph.edges.length, unresolved: graph.unresolved.length,
      megabytes: JSON.stringify(graph).length / 1e6,
    };
  }

  const edits = Number(args.edits ?? 0);
  if (edits > 0 && openText) {
    // Type into the middle of the file, one character at a time, waiting
    // for the diagnostics of each edit like a user pausing between keys.
    const lines = openText.split('\n');
    const line = Math.floor(lines.length / 2);
    const latencies = [];
    for (let i = 0; i < edits; i++) {
      const started = Date.now();
      const done = waitFor(m => m.method === 'textDocument/publishDiagnostics' && m.params.uri === openUri, 120);
      send({
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri: openUri, version: 2 + i },
          contentChanges: [{ range: { start: { line, character: 0 }, end: { line, character: 0 } }, text: '!' }],
        },
      });
      await done;
      latencies.push(Date.now() - started);
    }
    latencies.sort((a, b) => a - b);
    results.edits = { count: edits, medianMs: latencies[Math.floor(latencies.length / 2)], maxMs: latencies.at(-1) };
  }

  results.report = await request('qsp/performanceReport');
  finish(0);
} catch (e) {
  console.error(`\n${e.message}`);
  results.error = e.message;
  finish(1);
}

function finish(code) {
  if (results.done) return;
  results.done = true;
  clearInterval(memTimer);
  results.peakRssMb = canPs ? Math.round(peakRssMb) : undefined;
  const mem = results.report?.memory;
  const heapMb = mem ? Math.round(mem.heapUsed / 1048576) : undefined;
  results.perf = perfLines;

  console.log('\n── Summary ─────────────────────────────');
  console.log(`project        ${results.files} files, ${(results.chars / 1e6).toFixed(1)} MB`);
  if (results.firstDiagnosticsSeconds) console.log(`first diags    ${results.firstDiagnosticsSeconds.toFixed(1)} s (${results.openFile})`);
  if (results.readySeconds) console.log(`ready          ${results.readySeconds.toFixed(1)} s`);
  if (heapMb !== undefined) console.log(`heap at end    ${heapMb} MB of ${Math.round(mem.heapLimit / 1048576)} MB`);
  if (results.peakRssMb) console.log(`peak rss       ${results.peakRssMb} MB`);
  if (results.graph) console.log(`jump graph     ${results.graph.nodes} nodes, ${results.graph.edges} edges, ${results.graph.megabytes.toFixed(1)} MB in ${results.graph.seconds.toFixed(1)} s`);
  if (results.edits) console.log(`edits          median ${results.edits.medianMs} ms, max ${results.edits.maxMs} ms (${results.edits.count})`);
  if (results.crashed) console.log(`CRASHED        after ${results.crashed.seconds.toFixed(1)} s${results.crashed.outOfMemory ? ' (heap out of memory)' : ''}`);

  const over = [];
  if (args['max-seconds'] && !(results.readySeconds <= Number(args['max-seconds']))) over.push(`ready > ${args['max-seconds']} s`);
  if (args['max-heap-mb'] && !(heapMb <= Number(args['max-heap-mb']))) over.push(`heap > ${args['max-heap-mb']} MB`);
  if (over.length > 0) console.log(`OVER BUDGET    ${over.join(', ')}`);

  if (args.json) fs.writeFileSync(args.json, JSON.stringify(results, null, 2));

  const exitCode = code || (over.length > 0 ? 1 : 0);
  if (child.exitCode === null && child.signalCode === null) {
    request('shutdown').catch(() => {}).finally(() => send({ method: 'exit' }));
    setTimeout(() => { child.kill(); process.exit(exitCode); }, 3000).unref();
    child.on('exit', () => process.exit(exitCode));
  } else {
    process.exit(exitCode);
  }
}
