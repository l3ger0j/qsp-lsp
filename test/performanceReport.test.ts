/**
 * The performance report (src/server/performanceReport.ts) and the
 * profile path stripping (src/server/nodeProfiler.ts).
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
 *   analysis and kills the process: the profiler must record while the
 *   main thread is busy, and leave its files behind as it goes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { buildLocationIndex, countNodeTypes, newTreeStats } from '../src/parser';
import { buildPerformanceReport, distribution } from '../src/server/performanceReport';
import { NodeProfiler, stripProfilePaths } from '../src/server/nodeProfiler';
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
    const stats = newTreeStats();
    const tree = parser.parseOnce(CODE)!;
    countNodeTypes(tree, stats);
    tree.delete();
    const report = buildPerformanceReport({
      states: new Map([[SECRET_URI, state()]]),
      openUris: new Set([SECRET_URI]),
      parser: 'full', projectMode: true, embeddedExec: true, uptimeSeconds: 12.4,
      memory: { heapUsed: 1, heapLimit: 2 },
      aggregates: { locationDefs: new Map([['тайная_комната', 1]]), firstLocationKey: 'тайная_комната', flags: new Set([1, 2]) },
      treeStats: stats,
    });

    const json = JSON.stringify(report);
    for (const secret of ['Тайная', 'тайная', 'Подземелье', 'пароль', 'шифр', 'сокровище', 'ключ', 'сундук', 'амулет', 'Скрытый', 'someone', 'Секретная', 'main.qsps']) {
      expect(json).not.toContain(secret);
    }

    expect(report.files).toEqual([expect.objectContaining({ locations: 2, open: true, perLocation: false })]);
    expect(report.locations.chars.count).toBe(2);
    expect(report.symbols.locationRefSites).toBe(2);
    expect(report.symbols.actions).toBe(1);
    expect(report.symbols.localsInScopeEntries).toBeGreaterThan(0);
    expect(report.aggregates).toEqual({ locationDefs: 1, flags: 2 });
    expect(report.nodeTypes!.types.location_block.count).toBe(2);
    expect(report.nodeTypes!.maxDepth).toBeGreaterThan(2);
    expect(report.heaviestLocations).toHaveLength(2);
    expect(report.server.uptimeSeconds).toBe(12);
  });

  it('counts a file still being analysed, which a crash leaves unfinished', () => {
    const index = buildLocationIndex(CODE);
    const report = buildPerformanceReport({
      states: new Map(), openUris: new Set(), parser: 'full', projectMode: true, embeddedExec: true, uptimeSeconds: 1,
      inProgress: { locationIndex: index, parsedLocations: 1 },
    });
    const chars = index.reduce((n, l) => n + l.endOffset - l.startOffset, 0);
    expect(report.inProgress).toEqual({ chars, locations: 2, parsedLocations: 1 });
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

describe('NodeProfiler', () => {
  it('samples memory while the main thread is stuck in a synchronous loop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-profile-'));
    const profiler = new NodeProfiler();
    profiler.start(dir);
    // Let the sampler connect, then block the main thread for 3.5 s.
    await new Promise(r => setTimeout(r, 300));
    const keep: object[] = [];
    const until = Date.now() + 3500;
    while (Date.now() < until) keep.push({ n: keep.length });
    const csv = fs.readFileSync(path.join(dir, `memory-${process.pid}.csv`), 'utf8').trim().split('\n');
    // Rows written during the loop: the main thread never got to run a timer.
    expect(csv.length).toBeGreaterThanOrEqual(3);

    const files = await profiler.stop();
    expect(files).toEqual(expect.arrayContaining([`memory-${process.pid}.csv`, `cpu-${process.pid}.cpuprofile`, `heap-${process.pid}.heapprofile`]));
    const cpu = JSON.parse(fs.readFileSync(path.join(dir, `cpu-${process.pid}.cpuprofile`), 'utf8'));
    expect(cpu.nodes.every((n: { callFrame: { url: string } }) => !n.callFrame.url.includes('/'))).toBe(true);
    expect(keep.length).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
