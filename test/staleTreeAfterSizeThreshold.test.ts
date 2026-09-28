/**
 * Regression test: growing an open document past
 * `PER_LOCATION_BYTE_THRESHOLD` (500 KB) must not leave hover using a
 * stale, small, whole-document tree-sitter tree.
 *
 * Why
 * ───
 * `analyzeDocumentFullTree` caches a whole-document tree in
 * `QspTreeSitterParser` keyed by the document URI (`tsParser.parse(uri,
 * text)`). Once a document grows to/above the per-location threshold,
 * `analyzeDocumentPerLocation` takes over and must drop that tree
 * (`tsParser.removeTree(doc.uri)`). Otherwise it lingers in
 * `tsParser`'s internal map (a memory leak), AND `tsParser.getTree(uri)`
 * — used by hover / document-highlight in lspFeatures.ts — keeps
 * returning it instead of `null`, so those code paths never fall through
 * to the (correct) `perLocationCache` branch.
 *
 * Concretely: hover's "Possible values" resolver looks up the AST node
 * under the cursor via that tree. If the cursor is at a line number
 * that only exists in the NEW, much larger content, but the stale tree
 * only has the OLD few-line content, the node lookup fails silently and
 * the resolved value goes missing from the hover — even though the
 * correct per-location tree (with the correct line offset) has it.
 *
 * Test approach
 * ─────────────
 * Open a small document (well under the threshold, analysed via the
 * full-tree path) with `pl $g` on an early line. Then grow it — via a
 * real `textDocument/didChange` — to well over 500 KB by inserting a
 * large padding location plus a `$g` definition *before* that line, so
 * the `pl $g` usage moves to a line number far beyond what the stale
 * small tree could possibly contain. Hover on `$g` afterward must still
 * report "Possible values" containing the marker.
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
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  RegistrationRequest,
  type Hover,
  type InitializeParams,
  type PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol';
import { createQspServer } from '../src/server/common';
import { WASM_PATH } from './testHelpers';

async function startServer(): Promise<{ client: MessageConnection; diagnosticsFor: (uri: string, version?: number) => Promise<PublishDiagnosticsParams>; stop: () => void }> {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const serverConn = createConnection(new StreamMessageReader(c2s), new StreamMessageWriter(s2c));
  const documents = new TextDocuments(TextDocument);
  createQspServer(serverConn, documents, async () => fs.readFileSync(WASM_PATH));

  const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s));
  client.onRequest(RegistrationRequest.type, () => null);
  client.onRequest(ConfigurationRequest.type, (params) => params.items.map(() => null));
  client.onRequest('workspace/semanticTokens/refresh', () => null);

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
    diagnosticsFor: (uri) => new Promise((resolve) => {
      diagnosticBuckets.delete(uri);
      const cached = diagnosticBuckets.get(uri);
      if (cached) { resolve(cached); return; }
      const arr = diagnosticWaiters.get(uri) ?? [];
      arr.push(resolve);
      diagnosticWaiters.set(uri, arr);
    }),
    stop: () => { client.dispose(); c2s.destroy(); s2c.destroy(); },
  };
}

describe('per-location switch releases the stale whole-document tree', () => {
  let harness: Awaited<ReturnType<typeof startServer>> | undefined;
  afterEach(() => { harness?.stop(); harness = undefined; });

  it('hover resolves a value defined far beyond the old small tree\'s line count after the doc grows past 500KB', async () => {
    harness = await startServer();
    const { client, diagnosticsFor } = harness;
    const uri = 'file:///grows.qsps';

    // v1: tiny — analysed via the full-tree path, caching a whole-doc
    // tree with only 3 lines.
    const v1 = `# main\npl $g\n---\n`;
    client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'qsp', version: 1, text: v1 },
    });
    await diagnosticsFor(uri);

    // v2: grow past the 500KB per-location threshold by inserting a
    // large padding location AND the `$g` definition *before* `# main`,
    // pushing `pl $g` to a line number the old 3-line tree can't have.
    const padLine = '! ' + 'x'.repeat(120) + '\n';
    const padBody = padLine.repeat(Math.ceil(520_000 / padLine.length));
    const v2 = `# init\n$g = 'GREW_PAST_THRESHOLD'\n---\n# pad\n${padBody}---\n` + v1;
    expect(v2.length).toBeGreaterThan(500_000);
    const glinePl = v2.split('\n').findIndex(l => l === 'pl $g');
    expect(glinePl).toBeGreaterThan(1000); // sanity: far beyond the old 3-line tree

    client.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: v2 }],
    });
    await diagnosticsFor(uri);
    // The fast tier publishes an empty diagnostics array as soon as the
    // change lands; give the tree tier (500ms debounce) time to run its
    // per-location analysis too.
    await new Promise((r) => setTimeout(r, 900));

    const hover = await client.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line: glinePl, character: 4 }, // the `g` in `pl $g`
    }) as Hover | null;

    expect(hover, 'hover returned null').not.toBeNull();
    const md = hover && typeof hover.contents === 'object' && 'value' in hover.contents
      ? (hover.contents as { value: string }).value
      : '';
    expect(md).toContain('GREW_PAST_THRESHOLD');
  }, 30_000);
});
