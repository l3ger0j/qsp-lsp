/**
 * WASM-backed tree-sitter objects (trees, cursors) are not garbage
 * collected; every one must be freed with `.delete()`.
 *
 * Why
 * ───
 * - A file that shrinks below `PER_LOCATION_BYTE_THRESHOLD` switches to
 *   whole-file analysis. The trees retained in `perLocationCache` for
 *   locations ≥ `INCREMENTAL_LOC_THRESHOLD` must be freed then, because
 *   the new state no longer references them.
 * - Every `walk()` cursor must be freed, including the folding-range one.
 * - After `shutdown`, pending debounce timers must not fire into a
 *   disposed parser, and the parser's WASM memory is released.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';
import type Parser from 'web-tree-sitter';
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
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  FoldingRangeRequest,
  InitializeRequest,
  InitializedNotification,
  LogMessageNotification,
  RegistrationRequest,
  ShutdownRequest,
  type InitializeParams,
} from 'vscode-languageserver-protocol';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { createQspServer } from '../src/server/common';
import { initParser, loadWasm } from './testHelpers';

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
  client.onNotification(LogMessageNotification.type, (p) => { logs.push(p.message); });

  client.listen();
  await client.sendRequest(InitializeRequest.type, {
    processId: process.pid, rootUri: null, capabilities: {}, workspaceFolders: null,
  } as InitializeParams);
  client.sendNotification(InitializedNotification.type, {});
  return { client, logs, stop: () => { client.dispose(); c2s.destroy(); s2c.destroy(); } };
}

const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms)); // tree-tier debounce (500ms) + margin

/** Wraps a prototype method so every object it returns is recorded, and
 *  records which of those objects later had `.delete()` called. */
function trackAllocations<T extends object>(proto: object, method: string) {
  const created = new Set<T>();
  const deleted = new Set<T>();
  const stacks = new Map<T, string>();
  const orig = (proto as Record<string, (...a: unknown[]) => T>)[method];
  vi.spyOn(proto as Record<string, (...a: unknown[]) => T>, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
    const obj = orig.apply(this, args);
    if (obj && !created.has(obj)) {
      created.add(obj);
      stacks.set(obj, (new Error().stack ?? '').split('\n').slice(2, 7).join(' | '));
      // Chain to the current `delete`: Tree.walk() delegates to Node.walk(), so
      // one cursor can be wrapped by two trackers.
      const del = (obj as unknown as { delete: () => void }).delete;
      (obj as unknown as { delete: () => void }).delete = function () { deleted.add(obj); del.call(this); };
    }
    return obj;
  });
  const leaked = () => [...created].filter(o => !deleted.has(o));
  // Stacks, not the objects: printing a freed WASM object reads freed memory.
  return { created, leaked, leakedStacks: () => leaked().map(o => stacks.get(o)!) };
}

describe('tree-sitter WASM resource cleanup', () => {
  let protos: { tree: object; node: object };
  beforeAll(async () => {
    const p = new QspTreeSitterParser();
    await initParser(p);
    const tree = p.parseOnce('# a\npl 1\n---\n')!;
    protos = { tree: Object.getPrototypeOf(tree), node: Object.getPrototypeOf(tree.rootNode) };
    tree.delete();
  });

  let harness: Awaited<ReturnType<typeof startServer>> | undefined;
  afterEach(() => { harness?.stop(); harness = undefined; vi.restoreAllMocks(); });

  it('frees a retained location tree when its location goes away', async () => {
    const trees = trackAllocations<Parser.Tree>(QspTreeSitterParser.prototype, 'parseOnce');
    harness = await startServer();
    const uri = 'file:///shrink.qsps';
    // A location of 50 KB or more keeps its tree for incremental edits.
    const line = '! ' + 'x'.repeat(120) + '\n';
    const bigLoc = `# big\n${line.repeat(Math.ceil(60_000 / line.length))}---\n`;
    const small = `# small\npl 1\n---\n`;

    harness.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'qsp', version: 1, text: bigLoc + small },
    });
    await settle();
    expect(trees.leaked().length, 'the ≥50 KB location keeps its tree').toBeGreaterThan(0);

    harness.client.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: small }],
    });
    await settle();
    expect(trees.leakedStacks()).toEqual([]);
  }, 30_000);

  it('frees every tree cursor', async () => {
    const fromTree = trackAllocations<Parser.TreeCursor>(protos.tree, 'walk');
    const fromNode = trackAllocations<Parser.TreeCursor>(protos.node, 'walk');
    harness = await startServer();
    const uri = 'file:///fold.qsps';
    harness.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'qsp', version: 1, text: `# a\nif x:\n  pl 1\nend\nact 'go':\n  gt 'a'\nend\n---\n` },
    });
    await settle();
    const ranges = await harness.client.sendRequest(FoldingRangeRequest.type, { textDocument: { uri } });
    expect(ranges?.length).toBeGreaterThan(0);
    expect(fromTree.created.size + fromNode.created.size).toBeGreaterThan(0);
    expect([...fromTree.leakedStacks(), ...fromNode.leakedStacks()]).toEqual([]);
  }, 15_000);

  it('on shutdown, cancels pending analysis and disposes the parser', async () => {
    const dispose = vi.spyOn(QspTreeSitterParser.prototype, 'dispose');
    harness = await startServer();
    const uri = 'file:///shutdown.qsps';
    harness.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'qsp', version: 1, text: '# a\npl 1\n---\n' },
    });
    await settle();
    const parse = vi.spyOn(QspTreeSitterParser.prototype, 'parse');

    harness.client.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: '# a\npl 2\n---\n' }],
    });
    await harness.client.sendRequest(ShutdownRequest.type);
    await settle();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(parse, 'the debounced re-parse must not run after shutdown').not.toHaveBeenCalled();
  }, 15_000);
});
