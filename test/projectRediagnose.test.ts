/**
 * The fast tier's cross-file re-diagnosis in project mode.
 *
 * Why
 * ───
 * When an edit changes a file's location names, the fast tier (150 ms)
 * re-diagnoses the OTHER project files on a follow-up timer so their
 * cross-file duplicate errors update before the tree tier runs. That
 * timer must be tracked like the debounce timers:
 *  - after `shutdown` it must not fire and publish diagnostics;
 *  - two files whose fast tiers fire together get one re-diagnosis of
 *    the rest of the project, not one per edited file.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';
import { createConnection, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node';
import {
  ConfigurationRequest,
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  RegistrationRequest,
  ShutdownRequest,
  type InitializeParams,
} from 'vscode-languageserver-protocol';
import { createQspServer } from '../src/server/common';
import type { FsProvider } from '../src/server/serverUtils';
import { loadWasm } from './testHelpers';

const FILES: Record<string, string> = {
  '/proj/a.qsps': '# shared\npl 1\n---\n',
  '/proj/b.qsps': '# other\npl 2\n---\n',
  '/proj/c.qsps': '# shared\npl 3\n---\n',
};
const uriOf = (path: string) => `file://${path}`;

function memoryFs(): FsProvider {
  return {
    async readFile(path: string) {
      const text = FILES[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    async *findFiles(dir: string) {
      for (const path of Object.keys(FILES)) if (path.startsWith(dir)) yield path;
    },
    pathToUri: uriOf,
    uriToPath: (uri: string) => uri.replace('file://', ''),
  };
}

async function startProjectServer() {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const serverConn = createConnection(new StreamMessageReader(c2s), new StreamMessageWriter(s2c));
  createQspServer(serverConn, new TextDocuments(TextDocument), loadWasm, undefined, memoryFs());

  const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s));
  client.onRequest(RegistrationRequest.type, () => null);
  client.onRequest(ConfigurationRequest.type, (params) =>
    params.items.map(item => (item.section === 'qsp' ? { project: { enabled: true } } : null)));
  client.onRequest('workspace/semanticTokens/refresh', () => null);
  const published: string[] = [];
  client.onNotification(PublishDiagnosticsNotification.type, (p) => { published.push(p.uri); });
  client.listen();

  await client.sendRequest(InitializeRequest.type, {
    processId: process.pid, rootUri: null, capabilities: {},
    workspaceFolders: [{ uri: uriOf('/proj'), name: 'proj' }],
  } as InitializeParams);
  client.sendNotification(InitializedNotification.type, {});

  const open = (path: string) => client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: uriOf(path), languageId: 'qsp', version: 1, text: FILES[path] },
  });
  const edit = (path: string, text: string) => client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: uriOf(path), version: 2 },
    contentChanges: [{ text }],
  });
  return {
    client, published, open, edit,
    stop: () => { client.dispose(); c2s.destroy(); s2c.destroy(); },
  };
}

// Lets queued stream messages reach the other side; fake timers leave
// setImmediate real, so this still runs.
const flushIo = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

describe('project re-diagnosis after location names change', () => {
  let harness: Awaited<ReturnType<typeof startProjectServer>> | undefined;
  afterEach(() => { harness?.stop(); harness = undefined; vi.useRealTimers(); });

  async function openProject() {
    harness = await startProjectServer();
    // Project init scans memoryFs and parses every file.
    await new Promise(r => setTimeout(r, 800));
    harness.open('/proj/a.qsps');
    harness.open('/proj/b.qsps');
    await new Promise(r => setTimeout(r, 800));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    harness.published.length = 0;
    return harness;
  }

  it('does not publish diagnostics after shutdown', async () => {
    const h = await openProject();
    h.edit('/proj/a.qsps', '# renamed\npl 1\n---\n');
    await flushIo();
    // Fire only the fast tier (150 ms); its follow-up re-diagnosis is now pending.
    await vi.advanceTimersToNextTimerAsync();
    await flushIo();
    h.published.length = 0;

    await h.client.sendRequest(ShutdownRequest.type);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushIo();

    expect(h.published, 'nothing may be published after shutdown').toEqual([]);
  }, 15_000);

  it('re-diagnoses the rest of the project once when two files change together', async () => {
    const h = await openProject();
    h.edit('/proj/a.qsps', '# renamed_a\npl 1\n---\n');
    h.edit('/proj/b.qsps', '# renamed_b\npl 2\n---\n');
    await flushIo();
    // Both fast tiers are due at the same time; run them, then the follow-up,
    // but stop before the 500 ms tree tier re-diagnoses everything anyway.
    await vi.advanceTimersByTimeAsync(200);
    await flushIo();

    const forC = h.published.filter(u => u === uriOf('/proj/c.qsps'));
    expect(forC).toHaveLength(1);
  }, 15_000);
});
