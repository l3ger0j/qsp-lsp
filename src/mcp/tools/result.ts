// ── Tool results ─────────────────────────────────────────────────────

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { QspHost } from '../qspHost';

/** A tool result carrying `value` as JSON text. */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/**
 * Run a tool body: bring the server up to date with the disk first (unless
 * the tool doesn't touch the project), close what the body opened, and
 * turn a thrown error into an error result the agent can read instead of
 * a protocol failure.
 */
export async function run(
  host: QspHost,
  body: () => Promise<CallToolResult>,
  opts: { sync?: boolean } = {},
): Promise<CallToolResult> {
  try {
    if (opts.sync !== false) await host.sync();
    return await body();
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
  } finally {
    await host.closeAll();
  }
}
