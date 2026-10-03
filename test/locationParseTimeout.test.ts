/**
 * A location whose parse fails or times out loses only its own analysis.
 *
 * Why
 * ───
 * Every file is parsed one location at a time, each parse bounded on its
 * own. One that fails falls back to regex symbols for that location alone;
 * the others keep their full analysis (references, checks), in an open
 * document and in a closed project file alike.
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
  DidOpenTextDocumentNotification,
  InitializeRequest,
  InitializedNotification,
  LogMessageNotification,
  PublishDiagnosticsNotification,
  RegistrationRequest,
  type InitializeParams,
  type PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { createQspServer } from '../src/server/common';
import { ProjectModeService } from '../src/server/projectMode';
import type { DocumentState } from '../src/server/lspFeatures';
import { initParser, loadWasm } from './testHelpers';

// `start` calls `second`.
const TEXT = `# start\ngt 'second'\n---\n# second\npl 1\n---\n# third\npl 2\n---\n`;
// The location whose parse fails below.
const failing = (text: string) => text.startsWith('# second');

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
    messages: (uri: string) => (latest.get(uri)?.diagnostics ?? []).map(d => d.message),
    stop: () => { client.dispose(); c2s.destroy(); s2c.destroy(); },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 900)); // tree-tier debounce (500ms) + margin

describe('a failed location parse in an open document', () => {
  let harness: Awaited<ReturnType<typeof startServer>> | undefined;
  afterEach(() => { harness?.stop(); harness = undefined; vi.restoreAllMocks(); });

  it('leaves the other locations their full analysis', async () => {
    const realParseOnce = QspTreeSitterParser.prototype.parseOnce;
    let failed = 0;
    vi.spyOn(QspTreeSitterParser.prototype, 'parseOnce').mockImplementation(function (this: QspTreeSitterParser, text, ...rest) {
      if (!failing(text)) return realParseOnce.call(this, text, ...rest);
      failed++;
      return null;
    });
    harness = await startServer();
    const uri = 'file:///timeout.qsps';

    // `start` reads a variable nothing assigns: only a parsed location says so.
    const text = TEXT.replace("gt 'second'", "gt 'second'\n*pl никто");
    harness.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'qsp', version: 1, text },
    });
    await settle();

    expect(failed).toBeGreaterThan(0);
    expect(harness.messages(uri).filter(m => m.includes('never assigned'))).toEqual([`Variable 'никто' is used but never assigned`]);
  }, 15_000);
});

describe('a failed location parse in project mode', () => {
  const tsParser = new QspTreeSitterParser();
  beforeAll(() => initParser(tsParser));
  afterEach(() => { vi.restoreAllMocks(); });

  it('falls back to regex for that location only', () => {
    const realParseOnce = tsParser.parseOnce.bind(tsParser);
    vi.spyOn(tsParser, 'parseOnce').mockImplementation((text, timeoutMicros, oldTree) =>
      failing(text) ? null : realParseOnce(text, timeoutMicros, oldTree));

    const connection = { console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} } } as unknown as Connection;
    const documents = { get: () => undefined, all: () => [] } as unknown as TextDocuments<TextDocument>;
    const documentStates = new Map<string, DocumentState>();
    const project = new ProjectModeService(connection, documents, documentStates, tsParser);

    project.analyzeFile('file:///proj/t.qsps', TEXT);
    const symbols = documentStates.get('file:///proj/t.qsps')!.symbols;
    expect(symbols.getLocation('second')!.regexOnly).toBe(true);
    const start = symbols.getLocation('start')!;
    expect(start.regexOnly).toBe(false);
    expect([...start.locationRefs.keys()]).toEqual(['second']);
  });
});
