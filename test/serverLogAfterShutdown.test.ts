/**
 * `connection.console.*` and `connection.sendDiagnostics` throw
 * synchronously once the LSP connection is closed or disposed — this
 * happens for real when a debounced analysis timer fires after a client
 * disconnects mid-edit. `safeConsole`/`safeSendDiagnostics` must swallow
 * exactly that (Closed/Disposed), and nothing else.
 *
 * A real transport is deliberately not used here: destroying the actual
 * duplex streams to provoke this race also races vscode-jsonrpc's own
 * write-queue semaphore, which has its own pre-existing unhandled-rejection
 * behavior on a torn-down stream — a separate, third-party issue, not
 * something introduced or fixed by safeConsole/safeSendDiagnostics. A fake
 * connection that throws exactly the error these wrappers are meant to
 * catch tests the actual fix without that unrelated noise.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConnectionError, ConnectionErrors } from 'vscode-jsonrpc';
import type { Connection } from 'vscode-languageserver';
import { safeConsole, safeSendDiagnostics } from '../src/server/serverUtils';

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
