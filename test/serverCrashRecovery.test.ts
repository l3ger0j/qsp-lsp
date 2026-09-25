/**
 * Regression test: the server must not crash the whole process when the
 * LSP client rejects (or doesn't support) requests the server fires and
 * forgets, or when it starts up with tree-sitter disabled/lite mode.
 *
 * Why
 * ───
 * `connection.client.register(...)`, `connection.workspace
 * .getConfiguration(...)`, and `connection.languages.semanticTokens
 * .refresh()` all return Promises that the server fires and forgets.
 * Each needs a rejection handler (`.catch`, or `safeConnectionCall`,
 * which attaches one when `fn` returns a Promise).
 *
 * Neither `vscode-languageserver` nor `vscode-jsonrpc` installs a
 * process-level `unhandledRejection` handler, so Node's default applies:
 * an unhandled rejection becomes an uncaught exception that kills the
 * process. A perfectly LSP-compliant client that simply doesn't support
 * dynamic registration, or responds differently to
 * `workspace/configuration`, must not take the whole server down —
 * VS Code happens to support all three calls, but other clients
 * (Neovim, Helix, Zed, Sublime via an LSP plugin) may not.
 *
 * Test approach
 * ─────────────
 * Same real `createQspServer` + paired-`PassThrough` harness as
 * lspE2E.test.ts, except the test client responds to
 * `client/registerCapability`, `workspace/configuration`, and
 * `workspace/semanticTokens/refresh` with a `MethodNotFound` error
 * (a legal JSON-RPC response) instead of a normal result. A
 * process-level `unhandledRejection` listener records whether any
 * promise from the server side was ever left unhandled, and the test
 * asserts the server still answers a plain request (`hover`) afterward.
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
  ResponseError,
  ErrorCodes,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import {
  ConfigurationRequest,
  DidOpenTextDocumentNotification,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  RegistrationRequest,
  type Hover,
  type InitializeParams,
} from 'vscode-languageserver-protocol';
import { createQspServer } from '../src/server/common';
import { WASM_PATH } from './testHelpers';

type Scenario = 'reject-register' | 'reject-configuration' | 'reject-refresh' | 'control';

/**
 * Collects `unhandledRejection` events fired anywhere in this process
 * while active. Must be installed/removed around each test — it's a
 * process-global, not scoped to one harness instance.
 */
function trackUnhandledRejections(): { reasons: unknown[]; stop: () => void } {
  const reasons: unknown[] = [];
  const handler = (reason: unknown) => reasons.push(reason);
  process.on('unhandledRejection', handler);
  return { reasons, stop: () => process.off('unhandledRejection', handler) };
}

async function startServer(scenario: Scenario): Promise<{ client: MessageConnection; uri: string; stop: () => void }> {
  const c2s = new PassThrough();
  const s2c = new PassThrough();

  const serverConn = createConnection(new StreamMessageReader(c2s), new StreamMessageWriter(s2c));
  const documents = new TextDocuments(TextDocument);
  createQspServer(serverConn, documents, async () => fs.readFileSync(WASM_PATH));

  const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s));

  const reject = () => new ResponseError(ErrorCodes.MethodNotFound, 'not supported by this test client');

  client.onRequest(RegistrationRequest.type, () =>
    scenario === 'reject-register' ? reject() : null);
  client.onRequest(ConfigurationRequest.type, (params) =>
    scenario === 'reject-configuration' ? reject() : params.items.map(() => null));
  if (scenario !== 'reject-refresh') {
    client.onRequest('workspace/semanticTokens/refresh', () => null);
  }
  // else: leave it unregistered → vscode-jsonrpc replies MethodNotFound itself.

  client.listen();

  await client.sendRequest(InitializeRequest.type, {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
    workspaceFolders: null,
  } as InitializeParams);
  client.sendNotification(InitializedNotification.type, {});

  const uri = `file:///crash-${scenario}.qsps`;
  client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri, languageId: 'qsp', version: 1, text: `# a\n$v = 'x'\npl $v\n---\n` },
  });

  return {
    client,
    uri,
    stop: () => { client.dispose(); c2s.destroy(); s2c.destroy(); },
  };
}

describe('server does not crash when the client rejects fire-and-forget requests', () => {
  let tracker: ReturnType<typeof trackUnhandledRejections> | undefined;
  let harness: Awaited<ReturnType<typeof startServer>> | undefined;

  afterEach(() => {
    harness?.stop();
    harness = undefined;
    tracker?.stop();
    tracker = undefined;
  });

  const scenarios: Scenario[] = ['control', 'reject-register', 'reject-configuration', 'reject-refresh'];

  for (const scenario of scenarios) {
    it(`scenario: ${scenario}`, async () => {
      tracker = trackUnhandledRejections();
      harness = await startServer(scenario);

      // Give the fire-and-forget calls (register, getConfiguration,
      // refresh-after-analysis) time to settle/reject.
      await new Promise((r) => setTimeout(r, 1000));

      expect(tracker.reasons, `unhandled rejection(s) in scenario "${scenario}": ${tracker.reasons.map(String).join('; ')}`).toEqual([]);

      // The server must still be alive and answering requests.
      const hover = await harness.client.sendRequest(HoverRequest.type, {
        textDocument: { uri: harness.uri },
        position: { line: 2, character: 4 },
      }) as Hover | null;
      expect(hover).not.toBeNull();
    }, 15_000);
  }
});
