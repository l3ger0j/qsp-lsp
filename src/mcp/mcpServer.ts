// ── MCP server factory ───────────────────────────────────────────────
//
// Builds the McpServer with every QSP tool registered against a started
// QspHost. The stdio entry point (server.ts) and the tests share it.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { T2gModule } from '../common/txt2gamCore';
import type { QspHost } from './qspHost';
import { registerBuildTool } from './tools/build';
import { registerEditTools } from './tools/edit';
import { registerReadTools } from './tools/read';

export interface QspMcpOptions {
  /** Load the txt2gam module; the bundle and the tests find it differently. */
  loadTxt2gam: () => Promise<T2gModule>;
}

/** Every QSP tool and resource, answering for the project `host` holds. */
export function createQspMcpServer(host: QspHost, version: string, opts: QspMcpOptions): McpServer {
  const server = new McpServer(
    { name: 'qsp', version },
    {
      instructions: 'Tools for a QSP (Quest Soft Player) text-game project: its locations, references, '
        + 'diagnostics and builtins, as the QSP language server sees them. Names of locations, variables '
        + 'and objects are case-insensitive. Line numbers are 1-based.',
    },
  );
  registerReadTools(server, host);
  registerBuildTool(server, host, once(opts.loadTxt2gam));
  registerEditTools(server, host);
  return server;
}

// The txt2gam module is loaded on the first build and reused.
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= load());
}
