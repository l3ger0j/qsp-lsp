/**
 * Regression tests: project mode must not block the LSP server.
 *
 * Why
 * ───
 * The server runs on a single thread. A workspace scan that reads and
 * parses every file in one synchronous block stops every other request
 * (hover, completion, …) until it finishes, so:
 *  - `init()` consumes `FsProvider.findFiles` (an async iterable) and
 *    `await`s each `readFile`, yielding to the event loop between files
 *    (see the FsProvider doc comment in serverUtils.ts);
 *  - `handleWatchedFileChanges` applies a whole batch of watcher events
 *    and rebuilds the project aggregate ONCE — a `git checkout` touching
 *    hundreds of files must not trigger hundreds of full rebuilds;
 *  - the aggregates and diagnostics run in slices (slices.ts), answering
 *    requests between them; a rebuild started meanwhile takes over, and
 *    what the user looks at (the files just changed) is diagnosed first;
 *  - `analyzeFile` parses every file one location at a time — a single
 *    multi-MB parse can take seconds (the same GLR blowup
 *    `PER_LOCATION_BYTE_THRESHOLD` avoids for open documents), and a
 *    closed file must get the symbols an open one does.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import type { Connection, TextDocuments } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { ProjectModeService } from '../src/server/projectMode';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import type { DocumentState } from '../src/server/lspFeatures';
import type { FsProvider } from '../src/server/serverUtils';
import type { Diagnostic } from 'vscode-languageserver';
import { ALL_DIAGS_OFF, ALL_DIAGS_ON, WASM_PATH } from './testHelpers';

/** Minimal Connection stand-in: ProjectModeService only ever logs and
 *  calls sendDiagnostics on it. */
function fakeConnection(): Connection {
  return {
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    sendDiagnostics: () => {},
  } as unknown as Connection;
}

/** A Connection that keeps every publishDiagnostics, in order. */
function recordingConnection(): { connection: Connection; sent: Array<{ uri: string; diagnostics: Diagnostic[] }> } {
  const sent: Array<{ uri: string; diagnostics: Diagnostic[] }> = [];
  const connection = {
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    sendDiagnostics: (params: { uri: string; diagnostics: Diagnostic[] }) => { sent.push(params); },
  } as unknown as Connection;
  return { connection, sent };
}

/** Minimal TextDocuments stand-in: no files are "open" in the editor,
 *  matching the on-disk-scan scenario these tests exercise. */
function fakeDocuments(): TextDocuments<TextDocument> {
  return { get: () => undefined, all: () => [] } as unknown as TextDocuments<TextDocument>;
}

/** In-memory FsProvider over a Map<path, content>, mirroring the real
 *  nodeMain.ts implementation's async shape (including a directory-scan
 *  yield) without touching the real filesystem. */
function fakeFsProvider(files: Map<string, string>): FsProvider {
  return {
    async readFile(filePath: string): Promise<string> {
      const text = files.get(filePath);
      if (text === undefined) throw new Error(`ENOENT: ${filePath}`);
      return text;
    },
    async *findFiles(dir: string): AsyncIterable<string> {
      for (const path of files.keys()) {
        if (path.startsWith(dir)) {
          // Yield to the event loop per file, same as the real
          // implementation yields per directory — lets the
          // event-loop-yielding test below observe interleaving.
          await new Promise((resolve) => setImmediate(resolve));
          yield path;
        }
      }
    },
    pathToUri(filePath: string): string {
      return `file:///${filePath}`;
    },
    uriToPath(uri: string): string {
      return uri.replace('file:///', '');
    },
  };
}

describe('ProjectModeService: async, non-blocking, batched project mode', () => {
  const tsParser = new QspTreeSitterParser();
  beforeAll(async () => {
    await tsParser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('init() yields to the event loop between files instead of scanning synchronously', async () => {
    // 40 tiny files is enough to prove interleaving without a slow test.
    const files = new Map<string, string>();
    for (let i = 0; i < 40; i++) {
      files.set(`/proj/f${i}.qsps`, `# loc${i}\npl ${i}\n---\n`);
    }

    const documentStates = new Map<string, DocumentState>();
    const project = new ProjectModeService(fakeConnection(), fakeDocuments(), documentStates, tsParser);
    project.workspaceFolders = ['/proj'];

    let macrotasksObservedDuringInit = 0;
    const poller = setInterval(() => { macrotasksObservedDuringInit++; }, 0);

    await project.init(
      fakeFsProvider(files), 'utf8',
      () => new Map(), () => [], ALL_DIAGS_OFF,
    );
    clearInterval(poller);

    // If init() were one synchronous block, the timer callback would
    // never get a turn until after init() had already resolved, so this
    // count would be 0 (or vitest's own scheduling noise only after the
    // fact — the real signal is "at least one tick happened *during* the
    // 40-file scan", which setImmediate-based yielding guarantees here).
    expect(macrotasksObservedDuringInit).toBeGreaterThan(0);
    expect(project.projectFileUris.size).toBe(40);
    expect(documentStates.size).toBe(40);
  });

  it('handleWatchedFileChanges rebuilds project aggregates exactly once for a batch of changes', async () => {
    const files = new Map<string, string>([
      ['/proj/a.qsps', '# a\npl 1\n---\n'],
      ['/proj/b.qsps', '# b\npl 2\n---\n'],
      ['/proj/c.qsps', '# c\npl 3\n---\n'],
    ]);

    const documentStates = new Map<string, DocumentState>();
    const project = new ProjectModeService(fakeConnection(), fakeDocuments(), documentStates, tsParser);
    project.workspaceFolders = ['/proj'];
    await project.init(fakeFsProvider(files), 'utf8', () => new Map(), () => [], ALL_DIAGS_OFF);

    let rebuildCount = 0;
    const originalRebuildAggregates = project.rebuildAggregatesSteps.bind(project);
    project.rebuildAggregatesSteps = (collectCallTypes) => {
      rebuildCount++;
      return originalRebuildAggregates(collectCallTypes);
    };

    // Simulate the file watcher reporting all three files changed in one
    // batch (e.g. touched by an external tool) — changeType 2 = Changed.
    await project.handleWatchedFileChanges(
      [
        { uri: 'file:///proj/a.qsps', type: 2 },
        { uri: 'file:///proj/b.qsps', type: 2 },
        { uri: 'file:///proj/c.qsps', type: 2 },
      ],
      fakeFsProvider(files), 'utf8', ALL_DIAGS_OFF,
      () => new Map(), () => [],
    );

    expect(rebuildCount).toBe(1);
  });

  // Files with diagnostics of every kind the aggregates feed: unused and
  // uninitialized variables, calls passing locals, unused locations.
  function sliceProject(n: number) {
    const files = new Map<string, string>();
    for (let i = 0; i < n; i++) {
      files.set(`/proj/f${i}.qsps`, `# loc${i}\nlocal a${i} = ${i}\nx${i} = a${i}\npl y${i}\ngs 'loc${(i + 1) % n}'\n---\n`);
    }
    const { connection, sent } = recordingConnection();
    const documentStates = new Map<string, DocumentState>();
    const project = new ProjectModeService(connection, fakeDocuments(), documentStates, tsParser);
    project.workspaceFolders = ['/proj'];
    const rebuild = (changed?: string[]) => project.rebuildAndReanalyzeAll(ALL_DIAGS_ON, () => new Map(), () => [], { changed });
    // Every file's diagnostics from the aggregates as they stand.
    const truth = () => {
      const out = new Map<string, Diagnostic[]>();
      project.reanalyzeAll(ALL_DIAGS_ON, () => new Map(), () => [], () => undefined, out);
      return out;
    };
    const lastSent = () => new Map(sent.map(({ uri, diagnostics }) => [uri, diagnostics]));
    const uriOf = (i: number) => fakeFsProvider(files).pathToUri(`/proj/f${i}.qsps`);
    return { files, project, sent, rebuild, truth, lastSent, uriOf };
  }

  it('rebuilds the aggregates and diagnoses in slices, letting the event loop run between them', async () => {
    const p = sliceProject(30);
    await p.project.init(fakeFsProvider(p.files), 'utf8', () => new Map(), () => [], ALL_DIAGS_ON);
    p.project.sliceMs = 0;
    p.sent.length = 0;
    let ticks = 0;
    const poller = setInterval(() => { ticks++; }, 0);
    expect(await p.rebuild()).toBe(true);
    clearInterval(poller);
    expect(ticks).toBeGreaterThan(0);
    expect(p.sent.length).toBe(30);
    expect(p.lastSent()).toEqual(p.truth());
  });

  it('lets a rebuild started meanwhile take over, and resolves when that one is done', async () => {
    const p = sliceProject(30);
    await p.project.init(fakeFsProvider(p.files), 'utf8', () => new Map(), () => [], ALL_DIAGS_ON);
    p.project.sliceMs = 0;
    const order: string[] = [];
    const first = p.rebuild().then((done) => { order.push('first'); return done; });
    await new Promise((resolve) => setImmediate(resolve));
    // An edit between slices: a variable read in loc3 is now written there.
    const before = p.truth().get(p.uriOf(3));
    p.project.analyzeFile(p.uriOf(3), "# loc3\nlocal a3 = 3\nx3 = a3\ny3 = 1\npl y3\ngs 'loc4'\n---\n");
    const second = p.rebuild([p.uriOf(3)]).then((done) => { order.push('second'); return done; });
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(order).toEqual(['second', 'first']);
    expect(p.lastSent()).toEqual(p.truth());
    expect(p.lastSent().get(p.uriOf(3))).not.toEqual(before);
  });

  it('diagnoses the files an edit changed before the others', async () => {
    const p = sliceProject(10);
    await p.project.init(fakeFsProvider(p.files), 'utf8', () => new Map(), () => [], ALL_DIAGS_ON);
    // A new call: what the other files see of it changes, so all of them are diagnosed.
    p.project.analyzeFile(p.uriOf(7), "# loc7\nlocal a7 = 7\nx7 = a7\npl y7\ngs 'loc8'\ngs 'loc2'\n---\n");
    p.sent.length = 0;
    await p.rebuild([p.uriOf(7)]);
    expect(p.sent[0].uri).toBe(p.uriOf(7));
    expect(p.sent.length).toBe(10);
  });

  it('analyzeFile parses a large project file per-location instead of as one whole tree', () => {
    const documentStates = new Map<string, DocumentState>();
    const project = new ProjectModeService(fakeConnection(), fakeDocuments(), documentStates, tsParser);

    // A file of several MB would take seconds as one parse: build one
    // over 500 KB out of a few distinct locations.
    const padLine = '! ' + 'x'.repeat(120) + '\n';
    const padBody = padLine.repeat(Math.ceil(520_000 / (padLine.length * 3)));
    const text = `# init\n$g = 'FROM_LARGE_FILE'\n---\n`
      + `# pad_a\n${padBody}---\n`
      + `# pad_b\n${padBody}---\n`
      + `# pad_c\n${padBody}---\n`;
    expect(text.length).toBeGreaterThan(500_000);

    project.analyzeFile('file:///proj/big.qsps', text);

    const state = documentStates.get('file:///proj/big.qsps');
    expect(state).toBeDefined();
    expect(state!.locationIndex.map(l => l.name)).toEqual(['init', 'pad_a', 'pad_b', 'pad_c']);
    // The variable written in the first location must be visible through
    // the document-wide global-bindings index (rebuildGlobalBindings()
    // must have run) — this is what cross-file hover relies on.
    expect(state!.symbols.globalBindings.has('g')).toBe(true);
  });

  it('analyzeFile takes an action a syntax error hid from a small file\'s text', () => {
    // A whole-file parse of a closed file used to lose it, while the editor
    // and large files add it from the text (locationAnalysis.ts).
    const documentStates = new Map<string, DocumentState>();
    const project = new ProjectModeService(fakeConnection(), fakeDocuments(), documentStates, tsParser);
    project.analyzeFile('file:///proj/room.qsps', "# комната\n(((\nact 'взять':\n*pl 1\nend\n--- комната ---\n");
    const room = documentStates.get('file:///proj/room.qsps')!.symbols.getLocation('комната')!;
    expect(room.actions.map(a => a.name)).toEqual(['взять']);
  });

  it('init() without an FsProvider (browser) still builds the project from open documents', async () => {
    const openDoc = { uri: 'file:///proj/open.qsps', getText: () => '# open\ngt \'other\'\n---\n' };
    const documents = {
      get: (uri: string) => (uri === openDoc.uri ? openDoc : undefined),
      all: () => [openDoc],
    } as unknown as TextDocuments<TextDocument>;
    const documentStates = new Map<string, DocumentState>();
    const project = new ProjectModeService(fakeConnection(), documents, documentStates, tsParser);
    project.workspaceFolders = ['/proj'];

    await project.init(undefined, 'utf8', () => new Map(), () => [], ALL_DIAGS_OFF);

    expect([...project.projectFileUris]).toEqual([openDoc.uri]);
  });
});
