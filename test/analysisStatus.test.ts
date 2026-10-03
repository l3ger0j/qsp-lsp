/**
 * The analysis status shown in the language status item.
 *
 * Why
 * ───
 * - The server's parse is synchronous, so a large document's busy
 *   notification must be written out BEFORE the parse starts (the writer
 *   waits for the event loop), or the client would get "busy" and "done"
 *   together.
 * - Small documents and repeated identical states are not sent: they
 *   would only make the indicator flicker.
 * - Deferring the open's analysis must not let the change event that
 *   TextDocuments fires with every open re-parse the file: it is analyzed
 *   once per open.
 * - Until the server has read the settings it doesn't know whether project
 *   mode is on, so the item must not claim "Single file" in the meantime
 *   (a file opened first, which starts the server, used to show it).
 * - The client shows degraded modes (tree-sitter failed, a whole-file
 *   parse timed out) as warnings, but regex-only mode on vscode.dev is
 *   by design and is not a warning.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';
import type { Connection } from 'vscode-languageserver';
import { createConnection, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from 'vscode-jsonrpc/node';
import {
  ConfigurationRequest,
  DidOpenTextDocumentNotification,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  RegistrationRequest,
  type InitializeParams,
} from 'vscode-languageserver-protocol';
import {
  ANALYSIS_STATUS_MIN_BYTES,
  ANALYSIS_STATUS_NOTIFICATION,
  describeAnalysisStatus,
  type AnalysisStatus,
} from '../src/common/analysisStatus';
import { AnalysisStatusReporter } from '../src/server/analysisStatus';
import { createQspServer } from '../src/server/common';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { loadWasm } from './testHelpers';

const base: AnalysisStatus = { parser: 'full', busyUris: [], configured: true };
const A = 'file:///a.qsps';

describe('describeAnalysisStatus', () => {
  it('is ready with the project size when nothing is running', () => {
    expect(describeAnalysisStatus({ ...base, project: { state: 'ready', files: 3 } }, A))
      .toMatchObject({ text: 'Ready', detail: 'Project: 3 files', busy: false, warning: false });
    expect(describeAnalysisStatus(base, A).detail).toBe('Single file');
  });

  it('is busy while starting, loading the project, or analyzing the active file', () => {
    expect(describeAnalysisStatus({ ...base, parser: 'starting' }, A).busy).toBe(true);
    expect(describeAnalysisStatus({ ...base, project: { state: 'loading', files: 20 } }, A))
      .toMatchObject({ text: 'Loading project…', detail: '20 files found so far', busy: true });
    expect(describeAnalysisStatus({ ...base, busyUris: [A] }, A)).toMatchObject({ text: 'Analyzing…', busy: true });
  });

  it('does not call it a single file before the settings are read', () => {
    const unconfigured = { ...base, configured: false };
    expect(describeAnalysisStatus(unconfigured, A)).toMatchObject({ text: 'Starting…', busy: true });
    expect(describeAnalysisStatus({ ...unconfigured, busyUris: [A] }, A))
      .toMatchObject({ text: 'Analyzing…', detail: 'Reading settings…' });
    expect(describeAnalysisStatus(unconfigured, A).detail).not.toMatch(/single file/i);
  });

  it('does not spin for a file other than the active one', () => {
    expect(describeAnalysisStatus({ ...base, busyUris: ['file:///other.qsps'] }, A).busy).toBe(false);
  });

  it('warns when tree-sitter failed, but not in regex-only mode by design', () => {
    expect(describeAnalysisStatus({ ...base, parser: 'failed' }, A)).toMatchObject({ text: 'Limited mode', warning: true });
    expect(describeAnalysisStatus({ ...base, parser: 'lite' }, A)).toMatchObject({ text: 'Lite mode', warning: false });
  });
});

describe('AnalysisStatusReporter', () => {
  function reporter() {
    const sent: AnalysisStatus[] = [];
    const connection = {
      sendNotification: (_method: string, params: AnalysisStatus) => { sent.push(params); },
    } as unknown as Connection;
    return { r: new AnalysisStatusReporter(connection), sent };
  }

  it('sends nothing before start, then the accumulated state', () => {
    const { r, sent } = reporter();
    r.setParser('full');
    r.configure({ state: 'ready', files: 2 });
    expect(sent).toEqual([]);
    r.start();
    expect(sent).toEqual([{ parser: 'full', busyUris: [], configured: true, project: { state: 'ready', files: 2 } }]);
  });

  it('reports the settings and the project state they imply in one snapshot', () => {
    const { r, sent } = reporter();
    r.start();
    expect(sent.at(-1)).toMatchObject({ configured: false });
    r.configure({ state: 'loading', files: 0 });
    expect(sent.at(-1)).toMatchObject({ configured: true, project: { state: 'loading', files: 0 } });
    expect(sent.some(s => s.configured && !s.project)).toBe(false);
  });

  it('skips a snapshot identical to the last one', () => {
    const { r, sent } = reporter();
    r.start();
    r.setProject(undefined);
    r.setProject(undefined);
    expect(sent).toHaveLength(1);
  });

  it('keeps a document busy until every run of it has ended', () => {
    const { r } = reporter();
    r.begin(A);
    r.begin(A);
    r.end(A);
    expect(r.snapshot().busyUris).toEqual([A]);
    r.end(A);
    expect(r.snapshot().busyUris).toEqual([]);
  });

  it('forgets a closed document', () => {
    const { r } = reporter();
    r.begin(A);
    r.forget(A);
    expect(r.snapshot()).toMatchObject({ busyUris: [] });
  });
});

describe('server analysis status', () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; vi.restoreAllMocks(); });

  async function startServer(projectEnabled = false) {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const serverConn = createConnection(new StreamMessageReader(c2s), new StreamMessageWriter(s2c));
    createQspServer(serverConn, new TextDocuments(TextDocument), loadWasm);
    const client = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s));
    client.onRequest(RegistrationRequest.type, () => null);
    client.onRequest(ConfigurationRequest.type, (params) =>
      params.items.map(item => (item.section === 'qsp' ? { project: { enabled: projectEnabled } } : null)));
    client.onRequest('workspace/semanticTokens/refresh', () => null);
    const events: Array<{ kind: 'status'; status: AnalysisStatus } | { kind: 'diagnostics'; uri: string }> = [];
    client.onNotification(ANALYSIS_STATUS_NOTIFICATION, (status: AnalysisStatus) => { events.push({ kind: 'status', status }); });
    client.onNotification(PublishDiagnosticsNotification.type, (p) => { events.push({ kind: 'diagnostics', uri: p.uri }); });
    client.listen();
    await client.sendRequest(InitializeRequest.type, {
      processId: process.pid, rootUri: null, capabilities: {}, workspaceFolders: null,
    } as InitializeParams);
    client.sendNotification(InitializedNotification.type, {});
    stop = () => { client.dispose(); c2s.destroy(); s2c.destroy(); };
    await new Promise(r => setTimeout(r, 300));
    return { client, events, serverOutput: s2c };
  }

  const open = (client: Awaited<ReturnType<typeof startServer>>['client'], uri: string, text: string) =>
    client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'qsp', version: 1, text },
    });

  it('reports the parser, then the settings, once initialized', async () => {
    const { events } = await startServer();
    const statuses = events.flatMap(e => (e.kind === 'status' ? [e.status] : []));
    expect(statuses[0]).toMatchObject({ parser: 'full', configured: false });
    expect(statuses.at(-1)).toMatchObject({ parser: 'full', configured: true });
    // project.enabled is false in this harness.
    expect(statuses.at(-1)?.project).toBeUndefined();
  }, 15_000);

  it('in project mode, goes from unconfigured straight to loading the project', async () => {
    const { events } = await startServer(true);
    const statuses = events.flatMap(e => (e.kind === 'status' ? [e.status] : []));
    expect(statuses.some(st => st.configured && !st.project), 'never "configured, single file"').toBe(false);
    expect(statuses.find(st => st.configured)?.project?.state).toBe('loading');
    expect(statuses.at(-1)?.project?.state).toBe('ready');
  }, 15_000);

  it('writes the busy notification out before parsing a large document', async () => {
    const { client, events, serverOutput } = await startServer();
    events.length = 0;
    const uri = 'file:///big.qsps';
    const text = `# big\n${"pl 'padding text'\n".repeat(Math.ceil(ANALYSIS_STATUS_MIN_BYTES / 18) + 10)}---\n`;

    // Order of events on the server side: the busy message reaching the
    // output stream (what a real client reads from the pipe) vs. the parse.
    // Client-side arrival times prove nothing here: client and server share
    // one event loop, so the client reads only once the parse is over.
    const order: string[] = [];
    serverOutput.on('data', (chunk: Buffer) => {
      if (chunk.includes(ANALYSIS_STATUS_NOTIFICATION) && chunk.includes('big.qsps')) order.push('busy written');
    });
    const parseOnce = QspTreeSitterParser.prototype.parseOnce;
    vi.spyOn(QspTreeSitterParser.prototype, 'parseOnce').mockImplementation(function (this: QspTreeSitterParser, ...args) {
      order.push('parse');
      return parseOnce.apply(this, args);
    });

    open(client, uri, text);
    await new Promise(r => setTimeout(r, 1_500));

    expect(order.slice(0, 2)).toEqual(['busy written', 'parse']);
    const last = events.filter(e => e.kind === 'status').at(-1);
    expect(last?.kind === 'status' && last.status.busyUris).toEqual([]);
  }, 15_000);

  it('parses a newly opened document once, not again on its open-time change event', async () => {
    const { client } = await startServer();
    // One location: one parse per analysis.
    const parse = vi.spyOn(QspTreeSitterParser.prototype, 'parseOnce');
    open(client, 'file:///once.qsps', '# once\npl 1\n---\n');
    // Past the 500 ms tree-tier debounce the change event would have queued.
    await new Promise(r => setTimeout(r, 900));
    expect(parse).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('does not report a small document', async () => {
    const { client, events } = await startServer();
    events.length = 0;
    open(client, 'file:///small.qsps', '# small\npl 1\n---\n');
    await new Promise(r => setTimeout(r, 300));
    expect(events.some(e => e.kind === 'status')).toBe(false);
  }, 15_000);
});
