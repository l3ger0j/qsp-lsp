// ── "Turn off this check" quick fix ──────────────────────────────────
//
// The language server offers it on a QSP diagnostic (suppressionActions.ts)
// but can't write settings, so the client does: `qsp.diagnostics.<code>`
// goes to the workspace settings, where the whole team's game shares it.

import * as vscode from 'vscode';
import { isCheckCode } from '../common/diagnosticCodes';

/** Register the qsp.diagnostics.turnOff command. */
export function registerDiagnosticCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('qsp.diagnostics.turnOff', async (code: unknown) => {
      if (typeof code !== 'string' || !isCheckCode(code)) return;
      const config = vscode.workspace.getConfiguration('qsp.diagnostics');
      const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      const inspected = config.inspect(code);
      const previous = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
      // The one numeric check: 0 is its "off".
      const off = code === 'maxLocationLines' ? 0 : false;
      await config.update(code, off, target);
      const undo = 'Undo';
      const where = target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'user';
      const answer = await vscode.window.showInformationMessage(
        `QSP check '${code}' is off (qsp.diagnostics.${code} in the ${where} settings).`, undo);
      if (answer === undo) await config.update(code, previous, target);
    }),
  );
}
