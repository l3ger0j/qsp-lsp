/**
 * Failures that change what the user gets must be reported, not swallowed.
 *
 * Why
 * ───
 * - If tree-sitter fails to load, every feature silently degrades to
 *   regex analysis. Only a log line is not enough, so the server also
 *   shows a warning.
 * - When a project file is closed, the server re-reads it from disk.
 *   A deleted file (ENOENT) is expected, because the file watcher removes
 *   it. Any other read error, or a crash while re-analyzing, must reach
 *   the log instead of disappearing into an empty `.catch`.
 */
import { describe, it, expect, afterEach } from 'vitest';
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
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  InitializeRequest,
  InitializedNotification,
  LogMessageNotification,
  MessageType,
  RegistrationRequest,
  ShowMessageRequest,
  type InitializeParams,
  type LogMessageParams,
  type ShowMessageRequestParams,
} from 'vscode-languageserver-protocol';
import { createQspServer } from '../src/server/common';
import type { FsProvider } from '../src/server/serverUtils';
import { loadWasm } from './testHelpers';

const FILE_PATH = '/proj/a.qsps';
const FILE_URI = 'file:///proj/a.qsps';
const FILE_TEXT = '# a\npl 1\n---\n';

/** In-memory FsProvider whose `readFile` can be switched to fail with a given errno code. */
function fakeFsProvider() {
  const state: { failWith?: string } = {};
  const provider: FsProvider = {
    async readFile(): Promise<string> {
      if (state.failWith) throw Object.assign(new Error(`${state.failWith}: ${FILE_PATH}`), { code: state.failWith });
      return FILE_TEXT;
    },
    async *findFiles(): AsyncIterable<string> { yield FILE_PATH; },
    pathToUri: (p) => `file://${p}`,
    uriToPath: (u) => u.replace('file://', ''),
  };
  return { provider, state };
}

async function startServer(opts: { wasmLoader?: () => Promise<Buffer>; fsProvider?: FsProvider }) {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const serverConn = createConnection(new StreamMessageReader(c2s), new StreamMessageWriter(s2c));
  const documents = new TextDocuments(TextDocument);
  createQspServer(serverConn, documents, opts.wasmLoader, undefined, opts.fsProvider);

  const client: MessageConnection = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s));
  client.onRequest(RegistrationRequest.type, () => null);
  client.onRequest(ConfigurationRequest.type, (params) => params.items.map(() => null));
  client.onRequest('workspace/semanticTokens/refresh', () => null);

  const shown: ShowMessageRequestParams[] = [];
  const logged: LogMessageParams[] = [];
  client.onRequest(ShowMessageRequest.type, (p) => { shown.push(p); return null; });
  client.onNotification(LogMessageNotification.type, (p) => { logged.push(p); });

  client.listen();
  await client.sendRequest(InitializeRequest.type, {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
    workspaceFolders: opts.fsProvider ? [{ uri: 'file:///proj', name: 'proj' }] : null,
  } as InitializeParams);
  client.sendNotification(InitializedNotification.type, {});

  return {
    client, shown, logged,
    stop: () => { client.dispose(); c2s.destroy(); s2c.destroy(); },
  };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('server error reporting', () => {
  let harness: Awaited<ReturnType<typeof startServer>> | undefined;
  afterEach(() => { harness?.stop(); harness = undefined; });

  it('shows a warning when tree-sitter fails to initialize', async () => {
    harness = await startServer({ wasmLoader: async () => { throw new Error('wasm missing'); } });
    await settle(50);
    const warnings = harness.shown.filter(m => m.type === MessageType.Warning);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('regex mode');
  });

  it('shows no warning when tree-sitter initializes normally', async () => {
    harness = await startServer({ wasmLoader: loadWasm });
    await settle(50);
    expect(harness.shown).toEqual([]);
  });

  async function closeProjectFileWithReadError(code: string): Promise<LogMessageParams[]> {
    const fs = fakeFsProvider();
    harness = await startServer({ wasmLoader: loadWasm, fsProvider: fs.provider });
    await settle(200); // let project-mode init scan the fake workspace
    harness.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: FILE_URI, languageId: 'qsp', version: 1, text: FILE_TEXT },
    });
    await settle(50);
    fs.state.failWith = code;
    harness.client.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: FILE_URI } });
    await settle(100);
    return harness.logged.filter(m => m.type === MessageType.Error && m.message.includes('closed project file'));
  }

  it('logs a non-ENOENT read error when re-reading a closed project file', async () => {
    const errors = await closeProjectFileWithReadError('EACCES');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('EACCES');
  });

  it('stays quiet when the closed project file was deleted (ENOENT)', async () => {
    expect(await closeProjectFileWithReadError('ENOENT')).toEqual([]);
  });
});
