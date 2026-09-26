/**
 * Diagnostics of files opened while the project loads (common.ts).
 *
 * Why
 * ───
 * - An open file's own aggregates and diagnostics would be replaced
 *   seconds later by the project load's, made with project-wide ones.
 *   For a large game that was the longest step of its analysis done
 *   twice, with its memory held twice, so a file analysed while the
 *   project loads waits for the project's diagnostics instead.
 * - When no project comes (project mode off), the file must still get
 *   its own.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import { createConnection, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  createMessageConnection, StreamMessageReader, StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import {
  ConfigurationRequest, DidOpenTextDocumentNotification, InitializedNotification, InitializeRequest,
  PublishDiagnosticsNotification, RegistrationRequest, type Diagnostic, type InitializeParams,
} from 'vscode-languageserver-protocol';
import { createQspServer } from '../src/server/common';
import type { FsProvider } from '../src/server/serverUtils';
import { loadWasm } from './testHelpers';

const FILES: Record<string, string> = {
  '/proj/a.qsps': '# shared\npl 1\n---\n',
  '/proj/c.qsps': '# shared\npl 3\n---\n',
};
const uriOf = (path: string) => `file://${path}`;

async function start(projectEnabled: boolean) {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const fsProvider: FsProvider = {
    async readFile(path: string) { return FILES[path]; },
    // The scan waits for the test, so the project is still loading when
    // the file opens.
    async *findFiles(dir: string) {
      await gate;
      for (const path of Object.keys(FILES)) if (path.startsWith(dir)) yield path;
    },
    pathToUri: uriOf,
    uriToPath: (uri: string) => uri.replace('file://', ''),
  };
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  createQspServer(createConnection(new StreamMessageReader(c2s), new StreamMessageWriter(s2c)), new TextDocuments(TextDocument), loadWasm, undefined, fsProvider);
  const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s));
  client.onRequest(RegistrationRequest.type, () => null);
  client.onRequest(ConfigurationRequest.type, (params) =>
    params.items.map(item => (item.section === 'qsp' ? { project: { enabled: projectEnabled } } : null)));
  client.onRequest('workspace/semanticTokens/refresh', () => null);
  const published = new Map<string, Diagnostic[]>();
  client.onNotification(PublishDiagnosticsNotification.type, (p) => { published.set(p.uri, p.diagnostics); });
  client.listen();
  await client.sendRequest(InitializeRequest.type, {
    processId: process.pid, rootUri: null, capabilities: {},
    workspaceFolders: [{ uri: uriOf('/proj'), name: 'proj' }],
  } as InitializeParams);
  client.sendNotification(InitializedNotification.type, {});
  const open = (path: string) => client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: uriOf(path), languageId: 'qsp', version: 1, text: FILES[path] },
  });
  return { published, open, release, stop: () => { client.dispose(); c2s.destroy(); s2c.destroy(); } };
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('diagnostics of files opened while the project loads', () => {
  let h: Awaited<ReturnType<typeof start>> | undefined;
  afterEach(() => { h?.release(); h?.stop(); h = undefined; });

  it('come from the project load, with project-wide checks', async () => {
    h = await start(true);
    h.open('/proj/a.qsps');
    await wait(1200);
    expect(h.published.has(uriOf('/proj/a.qsps'))).toBe(false);

    h.release();
    await wait(1200);
    const diags = h.published.get(uriOf('/proj/a.qsps')) ?? [];
    // `shared` is defined in c.qsps too: only the project knows that.
    expect(diags.some(d => /shared/i.test(d.message) && /defined|duplicate/i.test(d.message))).toBe(true);
  }, 15_000);

  it("are the file's own when project mode is off", async () => {
    h = await start(false);
    h.open('/proj/a.qsps');
    await wait(1500);
    expect(h.published.has(uriOf('/proj/a.qsps'))).toBe(true);
  }, 15_000);
});
