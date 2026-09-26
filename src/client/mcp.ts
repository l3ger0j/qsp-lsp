// ── MCP server registration ──────────────────────────────────────────
//
// Offers the QSP MCP server (out/mcp/server.js, see src/mcp) to VS Code's
// agents, and a command that copies a config for agents outside VS Code.
// Desktop only: the server is a local stdio process.

import * as vscode from 'vscode';

// VS Code 1.101+ API. `engines.vscode` stays ^1.85, so these are declared
// here and looked up at runtime; on older versions nothing is registered.
interface McpStdioServerDefinitionCtor {
  new (label: string, command: string, args?: string[], env?: Record<string, string | number>, version?: string): unknown;
}
interface McpApi {
  registerMcpServerDefinitionProvider(id: string, provider: {
    onDidChangeMcpServerDefinitions?: vscode.Event<void>;
    provideMcpServerDefinitions(): unknown[];
  }): vscode.Disposable;
}

function serverPath(context: vscode.ExtensionContext): string {
  return vscode.Uri.joinPath(context.extensionUri, 'out', 'mcp', 'server.js').fsPath;
}

function workspaceFolderPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Register the MCP server provider (when the API exists) and the copy-config command. */
export function registerMcpServer(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('qsp.copyMcpConfig', () => copyMcpConfig(context)),
  );

  const lm = (vscode as unknown as { lm?: Partial<McpApi> }).lm;
  const Definition = (vscode as unknown as { McpStdioServerDefinition?: McpStdioServerDefinitionCtor }).McpStdioServerDefinition;
  if (typeof lm?.registerMcpServerDefinitionProvider !== 'function' || !Definition) return;

  const changed = new vscode.EventEmitter<void>();
  const version = String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0');
  context.subscriptions.push(
    changed,
    lm.registerMcpServerDefinitionProvider('qsp', {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => {
        const folder = workspaceFolderPath();
        if (!folder || !vscode.workspace.getConfiguration('qsp').get<boolean>('mcp.enabled', true)) return [];
        // process.execPath is the editor's own runtime; ELECTRON_RUN_AS_NODE
        // makes the Electron binary behave as plain Node on desktop, and is
        // ignored by the Node binary of a remote extension host.
        return [new Definition('QSP', process.execPath, [serverPath(context), '--workspace', folder], { ELECTRON_RUN_AS_NODE: '1' }, version)];
      },
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('qsp.mcp.enabled')) changed.fire(); }),
  );
}

async function copyMcpConfig(context: vscode.ExtensionContext): Promise<void> {
  const folder = workspaceFolderPath();
  // The editor's own runtime rather than `node` from PATH: an agent spawns
  // the server without the user's shell profile, so PATH may hold no Node
  // or an old system one (the server needs 18+). Same launch as the VS
  // Code registration above.
  const config = {
    mcpServers: {
      qsp: {
        command: process.execPath,
        args: [serverPath(context), ...(folder ? ['--workspace', folder] : [])],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    },
  };
  await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
  vscode.window.showInformationMessage(
    'QSP MCP server config copied. It points at this VS Code and this extension version, so copy it again after updating either.',
  );
}
