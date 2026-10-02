// ── Quick fixes that silence a check ─────────────────────────────────
//
// For a QSP diagnostic under the cursor: write a `!@qsp-ignore` comment
// for its line or its location (src/common/suppressions.ts reads them), or
// turn the check off in the workspace settings. Settings live on the client,
// so that one is a command the client runs (qsp.diagnostics.turnOff).

import { CodeAction, CodeActionKind, TextEdit, type Diagnostic } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { UNSUPPRESSIBLE_CODES, isCheckCode } from '../common/diagnosticCodes';
import { findLocationAtLine, type LocationEntry } from '../common/locations';

/** Client command that sets `qsp.diagnostics.<code>` to off; argument: the code. */
export const TURN_OFF_COMMAND = 'qsp.diagnostics.turnOff';

function lineText(doc: TextDocument, line: number): string {
  return doc.getText({ start: { line, character: 0 }, end: { line, character: Number.MAX_SAFE_INTEGER } });
}

function nameOf(d: Diagnostic): string | undefined {
  const name = (d.data as { name?: unknown } | undefined)?.name;
  // A comma or colon would be read as the directive's own punctuation.
  return typeof name === 'string' && name.trim() !== '' && !/[,:\r\n]/.test(name) ? name.trim() : undefined;
}

/** Quick fixes for the QSP diagnostics in `diagnostics` (those the editor sent for the cursor). */
export function buildSuppressionActions(
  doc: TextDocument,
  diagnostics: readonly Diagnostic[],
  locationIndex: readonly LocationEntry[],
  eol: string,
): CodeAction[] {
  const actions: CodeAction[] = [];
  const seen = new Set<string>();
  const add = (action: CodeAction) => {
    if (seen.has(action.title)) return;
    seen.add(action.title);
    actions.push(action);
  };

  for (const d of diagnostics) {
    if (d.source !== 'qsp' || typeof d.code !== 'string' || UNSUPPRESSIBLE_CODES.has(d.code)) continue;
    const code = d.code;
    const name = nameOf(d);
    const args = name ? `${code}: ${name}` : code;
    const about = name ? `'${code}' for '${name}'` : `'${code}'`;
    const line = d.range.start.line;
    const loc = findLocationAtLine(locationIndex as LocationEntry[], line);

    // Not above a location header (the comment would sit outside the
    // location), nor inside a statement continued from the line above.
    const continued = line > 0 && /\s_\s*$/.test(lineText(doc, line - 1));
    if (loc && line !== loc.startLine && !continued) {
      const indent = /^\s*/.exec(lineText(doc, line))![0];
      add({
        title: `Ignore ${about} on this line`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [d],
        edit: { changes: { [doc.uri]: [TextEdit.insert({ line, character: 0 }, `${indent}!@qsp-ignore ${args}${eol}`)] } },
      });
    }
    if (loc) {
      add({
        title: `Ignore ${about} in location '${loc.name}'`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [d],
        edit: { changes: { [doc.uri]: [TextEdit.insert({ line: loc.startLine + 1, character: 0 }, `!@qsp-ignore-location ${args}${eol}`)] } },
      });
    }
    if (isCheckCode(code)) {
      add({
        title: `Turn off '${code}' checks in this workspace`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [d],
        command: { title: `Turn off '${code}'`, command: TURN_OFF_COMMAND, arguments: [code] },
      });
    }
  }
  return actions;
}
