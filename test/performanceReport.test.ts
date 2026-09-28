/**
 * The performance report (src/server/performanceReport.ts) and the
 * profile path stripping (src/server/nodeRecorder.ts).
 *
 * Why
 * ───
 * - Users send the report for games they can't share: it must describe
 *   the project's shape in numbers and never carry file, location,
 *   variable or object names, or any text.
 * - The counts it holds (references, bindings, localsInScope snapshots)
 *   are the suspects for memory blow-ups, so they must add up correctly.
 * - Profiles carry script paths, which include the user's home folder.
 * - A game that exhausts memory does it inside one long synchronous
 *   analysis and kills the process: the recorder must record while the
 *   main thread is busy, and leave its files behind as it goes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { buildLocationIndex } from '../src/parser';
import { buildPerformanceReport, distribution } from '../src/server/performanceReport';
import { NodeRecorder, stackFrame, stripProfilePaths } from '../src/server/nodeRecorder';
import { Pseudonyms } from '../src/server/pseudonyms';
import type { DocumentState } from '../src/server/featureTypes';
import { initParser, parseAndExtract } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

const SECRET_URI = 'file:///home/someone/Секретная%20игра/main.qsps';
const CODE = [
  '# Тайная_комната',
  "local $пароль = 'шифр_7'",
  "$сокровище = 'золотой_ключ'",
  "gs 'Подземелье', $пароль",
  "act 'Открыть_сундук': addobj 'Проклятый_амулет'",
  '--- Тайная_комната ---',
  '# Подземелье',
  "*pl 'Скрытый текст сюжета'",
  "if $args[0] = '': gt 'Тайная_комната'",
  '--- Подземелье ---',
  '',
].join('\n');

function state(): DocumentState {
  const { symbols } = parseAndExtract(parser, CODE, SECRET_URI);
  return { locationIndex: buildLocationIndex(CODE), symbols };
}

describe('buildPerformanceReport', () => {
  it('counts the project without a single name or piece of text', () => {
    const report = buildPerformanceReport({
      states: new Map([[SECRET_URI, state()]]),
      pseudonyms: new Pseudonyms(),
      openUris: new Set([SECRET_URI]),
      parser: 'full', projectMode: true, embeddedExec: true, uptimeSeconds: 12.4,
      memory: { heapUsed: 1, heapLimit: 2 },
      aggregates: { locationDefs: new Map([['тайная_комната', 1]]), firstLocationKey: 'тайная_комната', flags: new Set([1, 2]) },
    });

    const json = JSON.stringify(report);
    for (const secret of ['Тайная', 'тайная', 'Подземелье', 'пароль', 'шифр', 'сокровище', 'ключ', 'сундук', 'амулет', 'Скрытый', 'someone', 'Секретная', 'main.qsps']) {
      expect(json).not.toContain(secret);
    }

    expect(report.files).toEqual([expect.objectContaining({ id: 'f01', locations: 2, open: true, perLocation: false })]);
    expect(report.locationTable.map(r => [r.id, r.actions])).toEqual([['f01_l0001', 1], ['f01_l0002', 0]]);
    expect(report.heaviestLocations[0].id).toBe('f01_l0001');
    expect(report.locations.chars.count).toBe(2);
    expect(report.symbols.locationRefSites).toBe(2);
    expect(report.symbols.actions).toBe(1);
    expect(report.symbols.localsInScopeEntries).toBeGreaterThan(0);
    expect(report.aggregates).toEqual({ locationDefs: 1, flags: 2 });
    expect(report.heaviestLocations).toHaveLength(2);
    expect(report.server.uptimeSeconds).toBe(12);
  });

  it('counts a file still being analysed, which a crash leaves unfinished', () => {
    const index = buildLocationIndex(CODE);
    const report = buildPerformanceReport({
      states: new Map(), pseudonyms: new Pseudonyms(), openUris: new Set(), parser: 'full', projectMode: true, embeddedExec: true, uptimeSeconds: 1,
      inProgress: { uri: SECRET_URI, locationIndex: index, parsedLocations: 1 },
    });
    const chars = index.reduce((n, l) => n + l.endOffset - l.startOffset, 0);
    expect(report.inProgress).toEqual({ file: 'f01', chars, locations: 2, parsedLocations: 1 });
    expect(report.locationTable.map(r => r.id)).toEqual(['f01_l0001', 'f01_l0002']);
    expect(report.locations.chars.count).toBe(2);
    expect(report.files).toEqual([]);
  });

  it('summarises distributions', () => {
    expect(distribution([5, 1, 3, 2, 4])).toEqual({ count: 5, total: 15, min: 1, median: 3, p90: 5, p99: 5, max: 5 });
    expect(distribution([])).toMatchObject({ count: 0, max: 0 });
  });
});

describe('stripProfilePaths', () => {
  it('keeps only file names in CPU and heap profiles', () => {
    const cpu = { nodes: [{ callFrame: { url: 'file:///C:/Users/someone/.vscode/extensions/qsp/out/server/nodeMain.js' } }, { callFrame: { url: '' } }] };
    stripProfilePaths(cpu);
    expect(cpu.nodes.map(n => n.callFrame.url)).toEqual(['nodeMain.js', '']);

    const heap = { head: { callFrame: { url: '/home/someone/x/a.js' }, children: [{ callFrame: { url: 'C:\\Users\\someone\\b.js' }, children: [] }] } };
    stripProfilePaths(heap);
    expect(heap.head.callFrame.url).toBe('a.js');
    expect(heap.head.children[0].callFrame.url).toBe('b.js');
  });
});

describe('stackFrame', () => {
  it('keeps the function and the file name, not the path', () => {
    expect(stackFrame('    at walk (C:\\Users\\Иван Петров\\.vscode\\extensions\\qsp\\out\\server\\nodeMain.js:12:345)')).toBe('walk (nodeMain.js:12:345)');
    expect(stackFrame('    at /home/someone/out/server/nodeMain.js:1:2')).toBe('nodeMain.js:1:2');
    expect(stackFrame('Error: Тайная_комната not found')).toBe('');
  });
});

describe('NodeRecorder', () => {
  // The handlers the recorder puts on the process, called directly: a
  // test can't exit its own process.
  type Handlers = { onExit: () => void; onUncaught: (e: unknown) => void };

  it('marks a run clean at once when it stops, and on a plain exit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-crash-'));
    const clean = path.join(dir, `clean-${process.pid}.json`);
    const recorder = new NodeRecorder();
    recorder.start(dir);
    expect(process.listeners('exit')).toContain((recorder as unknown as Handlers).onExit);
    (recorder as unknown as Handlers).onExit();
    expect(fs.existsSync(clean)).toBe(true);
    fs.rmSync(clean);

    const stopping = recorder.stop();
    // Written before the worker is asked to stop, so a server killed
    // right after its shutdown request still counts as clean.
    expect(fs.existsSync(clean)).toBe(true);
    await stopping;
    expect(process.listeners('exit')).not.toContain((recorder as unknown as Handlers).onExit);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('does not mark an exit after an uncaught exception clean, and leaves no message in its breadcrumb', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-crash-'));
    const recorder = new NodeRecorder();
    recorder.start(dir);
    const handlers = recorder as unknown as Handlers;
    handlers.onUncaught(new TypeError('Тайная_комната is not a function'));
    handlers.onExit();
    expect(fs.existsSync(path.join(dir, `clean-${process.pid}.json`))).toBe(false);
    const crumb = JSON.parse(fs.readFileSync(path.join(dir, `breadcrumbs-${process.pid}.jsonl`), 'utf8').trim());
    expect(crumb).toMatchObject({ kind: 'uncaught-exception', error: 'TypeError' });
    expect(crumb.frames.length).toBeGreaterThan(0);
    const text = JSON.stringify(crumb);
    expect(text).not.toContain('Тайная');
    expect(text).not.toContain(os.homedir());
    await recorder.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('leaves breadcrumbs naming where the analysis was, under pseudonyms', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-crash-'));
    const recorder = new NodeRecorder({ growthMb: 16, stallMs: 1500 });
    recorder.start(dir);
    recorder.phase('per-location analysis');
    recorder.file('f01', [{ id: 'f01_l0001', chars: 100, lines: 5 }, { id: 'f01_l0002', chars: 900, lines: 40 }]);
    recorder.location(1);
    recorder.step('symbols');
    await new Promise(r => setTimeout(r, 500));
    // Stuck on one location for 3.5 s, allocating.
    const keep: object[] = [];
    const until = Date.now() + 3500;
    while (Date.now() < until) keep.push({ n: keep.length, s: 'x'.repeat(64) });
    await new Promise(r => setTimeout(r, 1500));

    const crumbs = fs.readFileSync(path.join(dir, `breadcrumbs-${process.pid}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const kinds = new Set(crumbs.map(c => c.kind));
    expect(kinds.has('stall')).toBe(true);
    expect(kinds.has('heap-growth')).toBe(true);
    const stall = crumbs.find(c => c.kind === 'stall');
    expect(stall).toMatchObject({ phase: 'per-location analysis', step: 'symbols', file: 'f01', location: { id: 'f01_l0002', chars: 900, lines: 40 } });

    const files = await recorder.stop();
    expect(files).toEqual(expect.arrayContaining([`session-${process.pid}.json`, `clean-${process.pid}.json`, `memory-${process.pid}.csv`, `trail-${process.pid}.json`]));
    // Samples kept coming while the main thread was stuck in the loop.
    const rows = fs.readFileSync(path.join(dir, `memory-${process.pid}.csv`), 'utf8').trim().split('\n');
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(keep.length).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
