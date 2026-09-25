/**
 * Regression test: editing one open document to add a `gt`-style call
 * to a location defined in ANOTHER open document must update that
 * other document's cached semantic tokens (specifically its
 * GOTO_MODIFIER_BIT goto-highlighting).
 *
 * Bug context
 * ───────────
 * A document's semantic tokens depend on `collectCallTypesPerTarget`,
 * which merges call types across EVERY open document (not just itself)
 * to compute which location names are "goto targets" for the
 * goto-highlighting modifier. But `cachedSemanticTokens` was only ever
 * invalidated for the document that had just been re-analysed
 * (`documents.onDidChangeContent`, `analyzeDocumentFullTree`, …) — never
 * for OTHER open documents whose goto-target set the edit could also
 * affect.
 *
 * `connection.languages.semanticTokens.refresh()` tells the CLIENT its
 * cached tokens may be stale and to re-request them, but our own
 * server-side `cachedSemanticTokens` map was never told the same thing:
 * when the client re-requested document A's tokens, the handler
 * returned A's untouched, now-stale cache instead of recomputing.
 *
 * Fixed by `refreshSemanticTokens()` (common.ts), which clears every
 * open document's `cachedSemanticTokens` before asking the client to
 * refresh.
 *
 * Test approach
 * ─────────────
 * Open A (defines `target`) and B (calls nothing yet). Request A's
 * tokens (populates the cache). Edit B to add `gt 'target'`. Request
 * A's tokens again — it must differ from before, and must match what a
 * completely fresh server computes for the same final A+B state.
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
  SemanticTokensRequest,
  type InitializeParams,
  type PublishDiagnosticsParams,
  type SemanticTokens,
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
    tokensFor: async (uri: string) => {
      const result = await client.sendRequest(SemanticTokensRequest.type, {
        textDocument: { uri },
      }) as SemanticTokens;
      return result.data;
    },
    stop: () => { client.dispose(); c2s.destroy(); s2c.destroy(); },
  };
}

const A = `# start\npl 1\n---\n# target\npl 2\n---\n`;
const B_BEFORE = `# other\npl 3\n---\n`;
const B_AFTER = `# other\ngt 'target'\n---\n`;

describe('semantic tokens do not go stale across documents', () => {
  let harness: Awaited<ReturnType<typeof startServer>> | undefined;
  afterEach(() => { harness?.stop(); harness = undefined; });

  it('A\'s cached tokens update after B adds a gt call to A\'s location', async () => {
    harness = await startServer();
    const { client, diagnosticsFor, tokensFor } = harness;
    const aUri = 'file:///stale-a.qsps';
    const bUri = 'file:///stale-b.qsps';

    client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: aUri, languageId: 'qsp', version: 1, text: A },
    });
    client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: bUri, languageId: 'qsp', version: 1, text: B_BEFORE },
    });
    await Promise.all([diagnosticsFor(aUri), diagnosticsFor(bUri)]);

    // vscode-languageserver's TextDocuments fires onDidChangeContent (not
    // just onDidOpen) for a newly-opened document too, which schedules
    // that document's OWN fast/tree-tier debounce timers (150ms/500ms)
    // on top of the immediate synchronous analysis onDidOpen already
    // did. Wait for that self-triggered re-analysis to settle for BOTH
    // documents before taking the "before" measurement — otherwise it
    // could clear A's cache on its own a moment later, for reasons
    // unrelated to B's edit, and mask whether the fix actually did
    // anything.
    await new Promise((r) => setTimeout(r, 900));

    const before = await tokensFor(aUri); // populates A's cachedSemanticTokens

    client.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: bUri, version: 2 },
      contentChanges: [{ text: B_AFTER }],
    });
    // Same reasoning as above: wait past the tree tier's 500ms debounce
    // (the tier that recomputes call types and calls
    // refreshSemanticTokens()), with margin.
    await new Promise((r) => setTimeout(r, 900));

    const after = await tokensFor(aUri);

    harness.stop();
    harness = undefined;

    // Reference: a fresh server that starts with B already containing
    // the `gt 'target'` call — this is what `after` must match.
    const fresh = await startServer();
    fresh.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: aUri, languageId: 'qsp', version: 1, text: A },
    });
    fresh.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: bUri, languageId: 'qsp', version: 1, text: B_AFTER },
    });
    await Promise.all([fresh.diagnosticsFor(aUri), fresh.diagnosticsFor(bUri)]);
    await new Promise((r) => setTimeout(r, 900)); // let the open-triggered debounce settle here too
    const freshTokens = await fresh.tokensFor(aUri);
    fresh.stop();

    expect(after, 'A\'s tokens must change once B adds a gt call to a location A defines').not.toEqual(before);
    expect(after, 'A\'s tokens must match what a fresh server computes for the same final state').toEqual(freshTokens);
  }, 30_000);
});
