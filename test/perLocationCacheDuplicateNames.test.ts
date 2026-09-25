/**
 * Regression test: a duplicate location name in a >500KB file must not
 * permanently disable `tryIncrementalPerLocationUpdate`.
 *
 * Why
 * ───
 * If `perLocationCache` keys collide for two locations sharing a name,
 * `currentIndex.length !== prevCache.size` (the first check in
 * `tryIncrementalPerLocationUpdate`) is permanently true for that file —
 * every edit anywhere in the file falls back to a full per-location
 * re-analysis (`analyzeDocumentPerLocation`'s "Full analysis" path,
 * logged as "[QSP] Per-location parse: …") instead of the
 * O(1)-location incremental path, for as long as the duplicate exists.
 * Duplicate location names are flagged as an error, but the user may
 * have one for a while mid-edit. `perLocationCacheKeys`
 * (serverUtils.ts) gives each duplicate a distinct, stable key.
 *
 * Test approach
 * ─────────────
 * Open a >500KB document containing a duplicate location name, make a
 * few single-character inserts into an unrelated location (inserts, not
 * same-length replacements — see the comment in the test body), and
 * count how many times the server logs a full "Per-location parse:"
 * pass. A file with unique names serves as the control — both should
 * behave identically.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import { PassThrough } from 'stream';
import { createConnection, TextDocuments } from 'vscode-languageserver/node';
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
  DidChangeTextDocumentNotification,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  RegistrationRequest,
  type InitializeParams,
  type PublishDiagnosticsParams,
  type LogMessageParams,
} from 'vscode-languageserver-protocol';
import { createQspServer } from '../src/server/common';
import { WASM_PATH } from './testHelpers';

async function startServer() {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const serverConn = createConnection(new StreamMessageReader(c2s), new StreamMessageWriter(s2c));
  const documents = new TextDocuments(TextDocument);
  createQspServer(serverConn, documents, async () => fs.readFileSync(WASM_PATH));

  const client: MessageConnection = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s));
  client.onRequest(RegistrationRequest.type, () => null);
  client.onRequest(ConfigurationRequest.type, (params) => params.items.map(() => null));
  client.onRequest('workspace/semanticTokens/refresh', () => null);

  let fullPerLocationParses = 0;
  client.onNotification('window/logMessage', (p: LogMessageParams) => {
    if (p.message.includes('Per-location parse:')) fullPerLocationParses++;
  });

  const diagnosticBuckets = new Map<string, PublishDiagnosticsParams>();
  const diagnosticWaiters = new Map<string, ((p: PublishDiagnosticsParams) => void)[]>();
  client.onNotification(PublishDiagnosticsNotification.type, (params) => {
    diagnosticBuckets.set(params.uri, params);
    const waiters = diagnosticWaiters.get(params.uri);
    if (waiters) { diagnosticWaiters.delete(params.uri); for (const w of waiters) w(params); }
  });

  client.listen();
  await client.sendRequest(InitializeRequest.type, {
    processId: process.pid, rootUri: null, capabilities: {}, workspaceFolders: null,
  } as InitializeParams);
  client.sendNotification(InitializedNotification.type, {});

  return {
    client,
    diagnosticsFor: (uri: string) => new Promise<PublishDiagnosticsParams>((resolve) => {
      diagnosticBuckets.delete(uri);
      const arr = diagnosticWaiters.get(uri) ?? [];
      arr.push(resolve);
      diagnosticWaiters.set(uri, arr);
    }),
    fullParseCount: () => fullPerLocationParses,
    stop: () => { client.dispose(); c2s.destroy(); s2c.destroy(); },
  };
}

/** A >500KB document with a `counter` location whose value can be
 *  same-length-edited, plus enough padding to clear the per-location
 *  threshold. `duplicateName` controls whether `pad` appears twice. */
function makeDoc(duplicateName: boolean): string {
  const padLine = '! ' + 'x'.repeat(120) + '\n';
  const padBody = padLine.repeat(Math.ceil(520_000 / padLine.length));
  const secondPadName = duplicateName ? 'pad' : 'pad2';
  return `# counter\nx = 0\n---\n# pad\n${padBody}---\n# ${secondPadName}\n${padBody}---\n`;
}

describe('perLocationCache with a duplicate location name', () => {
  let harness: Awaited<ReturnType<typeof startServer>> | undefined;
  afterEach(() => { harness?.stop(); harness = undefined; });

  async function countFullParsesAcrossEdits(duplicateName: boolean): Promise<number> {
    harness = await startServer();
    const { client, diagnosticsFor, fullParseCount } = harness;
    const uri = `file:///dupnames-${duplicateName}.qsps`;
    const doc = makeDoc(duplicateName);
    expect(doc.length).toBeGreaterThan(500_000);

    client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'qsp', version: 1, text: doc },
    });
    await diagnosticsFor(uri);
    const afterOpen = fullParseCount();

    // Three zero-width inserts into `x = 0` (line 1), each growing that
    // one location's text length by one character. tryIncrementalPerLocationUpdate
    // detects the changed location by comparing text *lengths*, so —
    // unlike a same-length character replacement, which always falls
    // back to a full "equal-length substitution" re-parse — an insert
    // is what actually exercises the incremental path.
    for (let v = 0; v < 3; v++) {
      client.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version: v + 2 },
        contentChanges: [{
          range: { start: { line: 1, character: 5 }, end: { line: 1, character: 5 } },
          text: '!',
        }],
      });
      await new Promise((r) => setTimeout(r, 900)); // tree-tier debounce (500ms) + margin
    }

    harness.stop();
    harness = undefined;
    return fullParseCount() - afterOpen;
  }

  it('control: unique location names use the incremental path (0 extra full parses)', async () => {
    expect(await countFullParsesAcrossEdits(false)).toBe(0);
  }, 30_000);

  it('a duplicate location name no longer disables the incremental path', async () => {
    expect(await countFullParsesAcrossEdits(true)).toBe(0);
  }, 30_000);
});
