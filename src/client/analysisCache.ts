// ── Analysis cache: where it lives, and clearing it ──────────────────
//
// The language server keeps analysis results on disk (src/server/nodeCache.ts)
// in this workspace's own storage folder, outside the project, so nothing
// goes into the game's repository. It is read when the server starts.

import * as fs from 'fs';
import * as vscode from 'vscode';
import type { ServerLaunch } from './crashReports';
import * as logger from './logger';

function cacheDir(context: vscode.ExtensionContext): string | undefined {
  // No storage without an open folder: then there is no project to cache.
  return context.storageUri ? vscode.Uri.joinPath(context.storageUri, 'analysis-cache').fsPath : undefined;
}

/** Set the cache directory the server is started with, and register Clear Analysis Cache. */
export function registerAnalysisCache(context: vscode.ExtensionContext, launch: ServerLaunch): void {
  const applySetting = () => {
    const enabled = vscode.workspace.getConfiguration('qsp').get<boolean>('cache.enabled', true);
    // Read at the next server start.
    launch.cacheDir = enabled ? cacheDir(context) : undefined;
  };
  applySetting();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('qsp.cache.enabled')) applySetting();
    }),
    vscode.commands.registerCommand('qsp.clearAnalysisCache', async () => {
      const dir = cacheDir(context);
      if (!dir) {
        void vscode.window.showInformationMessage('There is no analysis cache without an open folder.');
        return;
      }
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
        logger.log('[Cache] Cleared the analysis cache');
        void vscode.window.showInformationMessage('The analysis cache is cleared. The next start analyses the project from scratch.');
      } catch (err) {
        void vscode.window.showErrorMessage(`Could not clear the analysis cache: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}
