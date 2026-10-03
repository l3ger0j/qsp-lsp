// ── Analysis status item ─────────────────────────────────────────────
//
// The `{}` language status item next to "QSP" in the status bar: what the
// server is doing (starting, loading the project, analyzing the file) and
// which degraded mode is in effect. The server sends the state; see
// src/server/analysisStatus.ts.

import * as vscode from 'vscode';
import type { BaseLanguageClient } from 'vscode-languageclient';
import {
  ANALYSIS_STATUS_NOTIFICATION,
  describeAnalysisStatus,
  type AnalysisStatus,
} from '../common/analysisStatus';

// Most analyses finish within this; a spinner for them would only flicker.
const BUSY_DELAY_MS = 300;

const settledEmitter = new vscode.EventEmitter<void>();

/**
 * Fires whenever the server reports that nothing is being analyzed: the
 * settings are read, no project scan and no document analysis is running.
 * Views built from the server's data (Locations, Jump Graph) refresh on it.
 * Small documents are analyzed without a busy report, so their updates
 * show up as diagnostics changes instead.
 */
export const onAnalysisSettled = settledEmitter.event;

function isSettled(status: AnalysisStatus): boolean {
  return status.configured && status.project?.state !== 'loading' && status.busyUris.length === 0;
}

/** Create the language status item and keep it in sync with the server. */
export function registerAnalysisStatus(context: vscode.ExtensionContext, client: BaseLanguageClient): void {
  const item = vscode.languages.createLanguageStatusItem('qsp.analysis', { language: 'qsp' });
  item.name = 'QSP Analysis';
  item.command = { title: 'Show Log', command: 'qsp.showServerLog' };
  context.subscriptions.push(
    item,
    vscode.commands.registerCommand('qsp.showServerLog', () => client.outputChannel.show(true)),
  );

  let status: AnalysisStatus = { parser: 'starting', busyUris: [], configured: false };
  let busyTimer: ReturnType<typeof setTimeout> | undefined;

  const render = () => {
    const view = describeAnalysisStatus(status, vscode.window.activeTextEditor?.document.uri.toString());
    item.text = view.text;
    item.detail = view.detail;
    item.severity = view.warning ? vscode.LanguageStatusSeverity.Warning : vscode.LanguageStatusSeverity.Information;
    if (!view.busy) {
      if (busyTimer) clearTimeout(busyTimer);
      busyTimer = undefined;
      item.busy = false;
    } else if (!item.busy && !busyTimer) {
      busyTimer = setTimeout(() => {
        busyTimer = undefined;
        item.busy = true;
      }, BUSY_DELAY_MS);
    }
  };

  context.subscriptions.push(
    client.onNotification(ANALYSIS_STATUS_NOTIFICATION, (next: AnalysisStatus) => {
      status = next;
      render();
      if (isSettled(next)) settledEmitter.fire();
    }),
    vscode.window.onDidChangeActiveTextEditor(render),
    { dispose: () => { if (busyTimer) clearTimeout(busyTimer); } },
  );
  render();
}
