// ── Edit tools ───────────────────────────────────────────────────────
//
// Semantic edits computed by the language server (rename, formatting).
// By default they only return what would change; `apply: true` writes the
// files. The MCP process sees only the disk, so unsaved editor changes are
// not part of the analysis, and a file changed since the analysis is not
// written at all.

import * as fs from 'fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  DocumentRangeFormattingRequest,
  RenameRequest,
  type TextEdit,
  type WorkspaceEdit,
} from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { encodeLike } from '../../server/nodeHost';
import type { QspHost } from '../qspHost';
import { setting } from './build';
import { findLocation, symbolPosition } from './read';
import { jsonResult, run } from './result';

const APPLY_DESCRIPTION = 'Write the changes (default false: only show them). Files with unsaved changes in an '
  + 'editor should be saved first: this tool edits the files on disk.';

function editsByUri(edit: WorkspaceEdit | null): Map<string, TextEdit[]> {
  const result = new Map<string, TextEdit[]>();
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) result.set(uri, edits);
  for (const change of edit?.documentChanges ?? []) {
    if ('edits' in change) result.set(change.textDocument.uri, [...(result.get(change.textDocument.uri) ?? []), ...change.edits]);
  }
  return result;
}

/**
 * Show or apply `edits`. Every file is checked before any is written, so a
 * refused apply leaves the project as it was.
 */
async function showOrApply(host: QspHost, edits: Map<string, TextEdit[]>, apply: boolean) {
  const files = [];
  const pending: Array<{ abs: string; text: string }> = [];
  for (const [uri, list] of edits) {
    if (list.length === 0) continue;
    const abs = URI.parse(uri).fsPath;
    host.resolve(abs);
    const doc = TextDocument.create(uri, 'qsp', 0, host.readText(abs));
    const oldLines = doc.getText().split(/\r\n|\r|\n/);
    const newText = TextDocument.applyEdits(doc, list);
    const newLines = newText.split(/\r\n|\r|\n/);
    // Line-by-line before/after is exact for single-line edits (renames);
    // a multi-line reformat shows the edited range as a whole instead.
    const changes = list.every(e => e.range.start.line === e.range.end.line && !/[\r\n]/.test(e.newText))
      ? [...new Set(list.map(e => e.range.start.line))].sort((a, b) => a - b)
        .map(line => ({ line: line + 1, before: oldLines[line], after: newLines[line] }))
      : list.map(e => ({
        line: e.range.start.line + 1,
        before: oldLines.slice(e.range.start.line, e.range.end.line + 1).join('\n'),
        after: e.newText,
      }));
    files.push({ file: host.relative(uri), changes });
    pending.push({ abs, text: newText });
  }

  if (apply) {
    const stale = pending.filter(p => !host.isUnchangedSinceSync(p.abs)).map(p => host.relative(host.uriOf(p.abs)));
    if (stale.length > 0) {
      throw new Error(`Not applied: changed on disk since the analysis: ${stale.join(', ')}. Run the tool again.`);
    }
    for (const p of pending) fs.writeFileSync(p.abs, encodeLike(p.text, fs.readFileSync(p.abs)));
    await host.sync();
  }
  return { applied: apply, files };
}

export function registerEditTools(server: McpServer, host: QspHost): void {
  server.registerTool('qsp_rename', {
    title: 'Rename across the QSP project',
    description: 'Rename a location, variable or object everywhere it is used in the project, as the editor\'s '
      + 'Rename does (headers, gt/goto/gosub targets, @calls, reads and writes). ' + APPLY_DESCRIPTION,
    inputSchema: {
      kind: z.enum(['location', 'variable', 'object']),
      name: z.string(),
      newName: z.string().min(1),
      apply: z.boolean().default(false).describe(APPLY_DESCRIPTION),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, ({ kind, name, newName, apply }) => run(host, async () => {
    const { uri, position } = await symbolPosition(host, kind, name);
    const edit = await host.lsp.sendRequest(RenameRequest.type, { textDocument: { uri }, position, newName });
    const edits = editsByUri(edit);
    if (edits.size === 0) throw new Error(`"${name}" can't be renamed to "${newName}"`);
    return jsonResult(await showOrApply(host, edits, apply));
  }));

  server.registerTool('qsp_format_location', {
    title: 'Format a QSP location',
    description: 'Re-indent one location the way the editor\'s Format command does. ' + APPLY_DESCRIPTION,
    inputSchema: {
      name: z.string(),
      apply: z.boolean().default(false).describe(APPLY_DESCRIPTION),
      tabSize: z.number().int().min(1).max(16).optional().describe('Default: the editor.tabSize setting, else 4'),
      insertSpaces: z.boolean().optional().describe('Default: the editor.insertSpaces setting, else true'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, ({ name, apply, tabSize, insertSpaces }) => run(host, async () => {
    const loc = await findLocation(host, name);
    await host.ensureOpen(loc.uri);
    const langScoped = (setting(host.settings, '[qsp]') ?? {}) as Record<string, unknown>;
    const pick = (key: string, fallback: unknown) => langScoped[key] ?? setting(host.settings, key) ?? fallback;
    const edits = await host.lsp.sendRequest(DocumentRangeFormattingRequest.type, {
      textDocument: { uri: loc.uri },
      range: { start: { line: loc.line, character: 0 }, end: { line: loc.endLine, character: 0 } },
      options: {
        tabSize: tabSize ?? Number(pick('editor.tabSize', 4)),
        insertSpaces: insertSpaces ?? pick('editor.insertSpaces', true) !== false,
      },
    });
    return jsonResult(await showOrApply(host, new Map([[loc.uri, edits ?? []]]), apply));
  }));
}
