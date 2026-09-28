/**
 * A whole-file parse that times out must neither freeze the server for
 * long nor drop the document to regex-only analysis.
 *
 * Why
 * ───
 * The server is single-threaded, so it answers nothing while a parse
 * runs. Files under `PER_LOCATION_BYTE_THRESHOLD` are parsed whole, and
 * that parse is bounded by `fullParseTimeoutMicros`, about twice the
 * normal parse time. On timeout the document switches to per-location
 * parsing (full symbols, each location bounded on its own) and stays
 * there while open, so later edits don't pay the timeout again.
 * Project-mode files that aren't open take the same fallback.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { PassThrough } from 'stream';
import { createConnection, TextDocuments } from 'vscode-languageserver/node';
import type { Connection } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import {
  ConfigurationRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  InitializeRequest,
  InitializedNotification,
  LogMessageNotification,
  PublishDiagnosticsNotification,
  RegistrationRequest,
  type InitializeParams,
  type PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol';
import { QspTreeSitterParser, fullParseTimeoutMicros } from '../src/parser/treeSitter';
import { createQspServer } from '../src/server/common';
import { ProjectModeService } from '../src/server/projectMode';
import type { DocumentState } from '../src/server/lspFeatures';
import { initParser, loadWasm } from './testHelpers';

describe('fullParseTimeoutMicros', () => {
  it('stays well under the old 30 s for a file just below the per-location threshold', () => {
    expect(fullParseTimeoutMicros(499_999)).toBeLessThan(10_000_000);
  });

  it('leaves room for a normal ~8 µs/char parse of that file', () => {
    expect(fullParseTimeoutMicros(499_999)).toBeGreaterThanOrEqual(499_999 * 8 * 1.5);
  });

  it('has a floor for small files', () => {
    expect(fullParseTimeoutMicros(10)).toBe(2_000_000);
  });
});

// `start` calls `second`; `third` is unreferenced. Tree-sitter analysis
// flags only `third`; regex-only analysis has no references and flags nothing.
const TEXT = `# start\ngt 'second'\n---\n# second\npl 1\n---\n# third\npl 2\n---\n`;

async function startServer() {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const serverConn = createConnection(new StreamMessageReader(c2s), new StreamMessageWriter(s2c));
  const documents = new TextDocuments(TextDocument);
  createQspServer(serverConn, documents, loadWasm);

  const client: MessageConnection = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s));
  client.onRequest(RegistrationRequest.type, () => null);
  client.onRequest(ConfigurationRequest.type, (params) => params.items.map(() => null));
  client.onRequest('workspace/semanticTokens/refresh', () => null);

  const logs: string[] = [];
  const latest = new Map<string, PublishDiagnosticsParams>();
  client.onNotification(LogMessageNotification.type, (p) => { logs.push(p.message); });
  client.onNotification(PublishDiagnosticsNotification.type, (p) => { latest.set(p.uri, p); });

  client.listen();
  await client.sendRequest(InitializeRequest.type, {
    processId: process.pid, rootUri: null, capabilities: {}, workspaceFolders: null,
  } as InitializeParams);
  client.sendNotification(InitializedNotification.type, {});

  return {
    client, logs,
    unreferenced: (uri: string) => (latest.get(uri)?.diagnostics ?? [])
      .map(d => d.message).filter(m => m.includes('never referenced')),
    stop: () => { client.dispose(); c2s.destroy(); s2c.destroy(); },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 900)); // tree-tier debounce (500ms) + margin

describe('whole-file parse timeout in an open document', () => {
  let harness: Awaited<ReturnType<typeof startServer>> | undefined;
  afterEach(() => { harness?.stop(); harness = undefined; vi.restoreAllMocks(); });

  it('falls back to per-location parsing with full references, and stays there', async () => {
    const parseSpy = vi.spyOn(QspTreeSitterParser.prototype, 'parse').mockReturnValue(null);
    harness = await startServer();
    const uri = 'file:///timeout.qsps';

    harness.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'qsp', version: 1, text: TEXT },
    });
    await settle();

    expect(harness.logs.some(m => m.includes('switching to per-location parsing'))).toBe(true);
    expect(harness.logs.some(m => m.includes('Per-location parse:'))).toBe(true);
    expect(harness.unreferenced(uri)).toEqual([`Location 'third' is defined but never referenced`]);

    const parseCallsAfterOpen = parseSpy.mock.calls.length;
    harness.client.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: 2 },
      contentChanges: [{ range: { start: { line: 4, character: 4 }, end: { line: 4, character: 4 } }, text: '0' }],
    });
    await settle();
    expect(parseSpy.mock.calls.length, 'edits must not retry the whole-file parse').toBe(parseCallsAfterOpen);
    expect(harness.unreferenced(uri)).toEqual([`Location 'third' is defined but never referenced`]);

    harness.client.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    parseSpy.mockRestore();
    harness.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'qsp', version: 3, text: TEXT },
    });
    await settle();
    expect(harness.logs.filter(m => m.includes('switching to per-location parsing')), 'reopening retries the whole-file parse')
      .toHaveLength(1);
  }, 15_000);
});

describe('whole-file parse timeout in project mode', () => {
  const tsParser = new QspTreeSitterParser();
  beforeAll(() => initParser(tsParser));
  afterEach(() => { vi.restoreAllMocks(); });

  it('falls back to per-location parsing instead of regex', () => {
    const realParseOnce = tsParser.parseOnce.bind(tsParser);
    vi.spyOn(tsParser, 'parseOnce').mockImplementation((text, timeoutMicros, oldTree) =>
      text === TEXT ? null : realParseOnce(text, timeoutMicros, oldTree));

    const connection = { console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} } } as unknown as Connection;
    const documents = { get: () => undefined, all: () => [] } as unknown as TextDocuments<TextDocument>;
    const documentStates = new Map<string, DocumentState>();
    const project = new ProjectModeService(connection, documents, documentStates, tsParser);

    project.analyzeFile('file:///proj/t.qsps', TEXT);
    const start = documentStates.get('file:///proj/t.qsps')!.symbols.getLocation('start')!;
    expect(start.regexOnly).toBe(false);
    expect([...start.locationRefs.keys()]).toEqual(['second']);
  });
});
