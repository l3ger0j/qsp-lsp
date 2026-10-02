/**
 * `connection.console.*` throws synchronously once the LSP connection is
 * closed or disposed, and `connection.sendDiagnostics` can also reject
 * asynchronously when the write itself fails. Both happen for real when a
 * debounced analysis timer fires after a client disconnects mid-edit.
 * `safeConsole`/`safeSendDiagnostics` must swallow exactly Closed/Disposed
 * and let anything else surface.
 *
 * A fake connection is used instead of a real transport: tearing down real
 * streams mid-write also triggers vscode-jsonrpc's `sendRequest`, whose
 * `new Promise(async …)` executor rethrows the write error after rejecting
 * the caller's promise. That rethrow rejects a promise nobody holds, so no
 * caller-side `.catch` can reach it — a third-party issue these wrappers
 * don't cover.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConnectionError, ConnectionErrors } from 'vscode-jsonrpc';
import type { Connection } from 'vscode-languageserver';
import { dropIdleTrees, safeConsole, safeSendDiagnostics } from '../src/server/serverUtils';
import type { DocumentState, PerLocationParseResult } from '../src/server/featureTypes';

function throwing(err: unknown): () => never {
  return () => { throw err; };
}

describe('safeConsole', () => {
  for (const method of ['log', 'warn', 'error', 'info'] as const) {
    it(`${method}: swallows a Closed error instead of throwing`, () => {
      const raw = { console: { [method]: throwing(new ConnectionError(ConnectionErrors.Closed, 'Connection is closed.')) } } as unknown as Connection;
      expect(() => safeConsole(raw)[method]('msg')).not.toThrow();
    });

    it(`${method}: swallows a Disposed error instead of throwing`, () => {
      const raw = { console: { [method]: throwing(new ConnectionError(ConnectionErrors.Disposed, 'Connection is disposed.')) } } as unknown as Connection;
      expect(() => safeConsole(raw)[method]('msg')).not.toThrow();
    });

    it(`${method}: rethrows any other error`, () => {
      const raw = { console: { [method]: throwing(new Error('boom')) } } as unknown as Connection;
      expect(() => safeConsole(raw)[method]('msg')).toThrow('boom');
    });

    it(`${method}: calls through when the connection is open`, () => {
      const spy = vi.fn();
      const raw = { console: { [method]: spy } } as unknown as Connection;
      safeConsole(raw)[method]('msg');
      expect(spy).toHaveBeenCalledWith('msg');
    });
  }
});

describe('safeSendDiagnostics', () => {
  const params = { uri: 'file:///a.qsps', diagnostics: [] };

  it('swallows a synchronous Closed throw', () => {
    const raw = { sendDiagnostics: throwing(new ConnectionError(ConnectionErrors.Closed, 'Connection is closed.')) } as unknown as Connection;
    expect(() => safeSendDiagnostics(raw, params)).not.toThrow();
  });

  it('swallows an async-rejected Closed promise (write fails after the sync not-closed check passes)', async () => {
    const raw = { sendDiagnostics: () => Promise.reject(new ConnectionError(ConnectionErrors.Closed, 'Connection is closed.')) } as unknown as Connection;
    expect(() => safeSendDiagnostics(raw, params)).not.toThrow();
    await new Promise((r) => setImmediate(r)); // let the rejection settle
  });

  it('rethrows a synchronous non-connection error', () => {
    const raw = { sendDiagnostics: throwing(new Error('boom')) } as unknown as Connection;
    expect(() => safeSendDiagnostics(raw, params)).toThrow('boom');
  });

  it('logs (but does not crash on) an async-rejected non-connection error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = { sendDiagnostics: () => Promise.reject(new Error('boom')) } as unknown as Connection;
    expect(() => safeSendDiagnostics(raw, params)).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('calls through when the connection is open', () => {
    const spy = vi.fn();
    const raw = { sendDiagnostics: spy } as unknown as Connection;
    safeSendDiagnostics(raw, params);
    expect(spy).toHaveBeenCalledWith(params);
  });
});

// Trees kept for incremental edits of large locations hold WASM memory for
// as long as the file is open; those nobody used for a while are freed,
// and only those.
describe('dropIdleTrees', () => {
  const tree = () => ({ delete: vi.fn() });
  const entry = (t: ReturnType<typeof tree> | undefined, usedAt?: number) =>
    ({ text: '', symbolsLine: 0, errors: [], tree: t, treeUsedAt: usedAt }) as unknown as PerLocationParseResult;

  it('frees trees idle for longer than the limit and keeps the rest', () => {
    const idle = tree();
    const recent = tree();
    const cache = new Map([['старая', entry(idle, 1_000)], ['новая', entry(recent, 9_000)], ['без дерева', entry(undefined)]]);
    const states = [{ perLocationCache: cache } as DocumentState, {} as DocumentState];

    expect(dropIdleTrees(states, 10_000, 5_000)).toBe(1);
    expect(idle.delete).toHaveBeenCalledOnce();
    expect(cache.get('старая')!.tree).toBeUndefined();
    expect(recent.delete).not.toHaveBeenCalled();
    expect(cache.get('новая')!.tree).toBe(recent);

    expect(dropIdleTrees(states, 10_000, 5_000)).toBe(0);
    expect(idle.delete).toHaveBeenCalledOnce();
  });
});
