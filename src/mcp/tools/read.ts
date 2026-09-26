// ── Read-only tools ──────────────────────────────────────────────────
//
// Questions about the project: locations, references, diagnostics,
// builtins. Line numbers are 1-based in every result, as editors show them.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  DiagnosticSeverity,
  ReferencesRequest,
  type Diagnostic,
  type Location,
} from 'vscode-languageserver-protocol';
import { URI } from 'vscode-uri';
import { ALL_BUILTINS, lookupBuiltin, type BuiltinInfo } from '../../parser';
import type { QspHost } from '../qspHost';
import { jsonResult, run } from './result';

export interface LocationItem { name: string; uri: string; line: number; endLine: number }
interface NamedItem { name: string; uri: string; line: number; isDefined: boolean }
interface VariableItem extends NamedItem { isLocal: boolean; prefixes: string[] }

const SEVERITY_NAMES: Record<number, string> = {
  [DiagnosticSeverity.Error]: 'error',
  [DiagnosticSeverity.Warning]: 'warning',
  [DiagnosticSeverity.Information]: 'info',
  [DiagnosticSeverity.Hint]: 'hint',
};

// ── Shared lookups (also used by the edit tools) ─────────────────────

export async function listLocations(host: QspHost): Promise<LocationItem[]> {
  return host.lsp.sendRequest<LocationItem[]>('qsp/listLocations', { uri: host.rootUri });
}

/** The location named `name` (QSP names are case-insensitive). */
export async function findLocation(host: QspHost, name: string): Promise<LocationItem> {
  const lower = name.trim().toLowerCase();
  const loc = (await listLocations(host)).find(l => l.name.toLowerCase() === lower);
  if (!loc) throw new Error(`No location named "${name}"`);
  return loc;
}

/**
 * Column of `name` in `lineText`, as a whole word and ignoring case, so an
 * LSP request can be made at that position. A `$`/`#`/`%` type prefix or
 * surrounding quotes don't count as part of the word.
 */
export function findNameColumn(lineText: string, name: string): number {
  const lower = lineText.toLowerCase();
  const target = name.toLowerCase();
  const isNameChar = (c: string | undefined) => c !== undefined && /[^\s&'"()[\]=!<>+\-/*:,{}]/.test(c);
  for (let i = lower.indexOf(target); i >= 0; i = lower.indexOf(target, i + 1)) {
    const before = lineText[i - 1];
    const after = lineText[i + target.length];
    if ((!isNameChar(before) || /[$#%]/.test(before!)) && !isNameChar(after)) return i;
  }
  throw new Error(`"${name}" not found on its line`);
}

export async function lineOf(host: QspHost, uri: string, line: number): Promise<string> {
  const text = await host.ensureOpen(uri);
  return text.split(/\r\n|\r|\n/)[line] ?? '';
}

export type SymbolKind = 'location' | 'variable' | 'object';

/**
 * Where the definition (or first use) of a location, variable or object is,
 * as an LSP position in a document that is open in the server.
 */
export async function symbolPosition(
  host: QspHost,
  kind: SymbolKind,
  name: string,
): Promise<{ uri: string; position: { line: number; character: number } }> {
  const bare = name.trim().replace(/^[$#%]/, '');
  let uri: string;
  let line: number;
  if (kind === 'location') {
    ({ uri, line } = await findLocation(host, bare));
  } else {
    const method = kind === 'variable' ? 'qsp/listVariables' : 'qsp/listObjects';
    const items = await host.lsp.sendRequest<NamedItem[]>(method, { uri: host.rootUri });
    const lower = bare.toLowerCase();
    const item = items.find(i => i.name.toLowerCase() === lower);
    if (!item) throw new Error(`No ${kind} named "${name}"`);
    ({ uri, line } = item);
  }
  return { uri, position: { line, character: findNameColumn(await lineOf(host, uri, line), bare) } };
}

async function describeLocations(host: QspHost, locations: Location[]) {
  const result = [];
  for (const l of locations) {
    const text = host.readText(URI.parse(l.uri).fsPath).split(/\r\n|\r|\n/)[l.range.start.line] ?? '';
    result.push({ file: host.relative(l.uri), line: l.range.start.line + 1, text: text.trim() });
  }
  return result;
}

function describeDiagnostic(host: QspHost, uri: string, d: Diagnostic, lineOffset = 0) {
  return {
    ...(uri ? { file: host.relative(uri) } : {}),
    line: d.range.start.line + 1 + lineOffset,
    column: d.range.start.character + 1,
    severity: SEVERITY_NAMES[d.severity ?? DiagnosticSeverity.Error],
    message: d.message,
  };
}

function describeBuiltin(b: BuiltinInfo) {
  return {
    name: b.name,
    kind: b.kind,
    ...(b.signature ? { signature: b.signature } : {}),
    description: b.description,
  };
}

// ── Registration ─────────────────────────────────────────────────────

export function registerReadTools(server: McpServer, host: QspHost): void {
  server.registerTool('qsp_list_locations', {
    title: 'List QSP locations',
    description: 'List the locations of the QSP project: name, file and line range (1-based). '
      + 'Names are case-insensitive in QSP.',
    inputSchema: { filter: z.string().optional().describe('Only locations whose name contains this text (case-insensitive)') },
    annotations: { readOnlyHint: true },
  }, ({ filter }) => run(host, async () => {
    const f = filter?.toLowerCase();
    return jsonResult((await listLocations(host))
      .filter(l => !f || l.name.toLowerCase().includes(f))
      .map(l => ({ name: l.name, file: host.relative(l.uri), startLine: l.line + 1, endLine: l.endLine + 1 })));
  }));

  server.registerTool('qsp_get_location', {
    title: 'Get a QSP location',
    description: 'Return the source of one location, from its `# name` header to its `---` line, with its file and lines.',
    inputSchema: { name: z.string().describe('Location name') },
    annotations: { readOnlyHint: true },
  }, ({ name }) => run(host, async () => {
    const loc = await findLocation(host, name);
    const lines = host.readText(URI.parse(loc.uri).fsPath).split(/\r\n|\r|\n/);
    return jsonResult({
      name: loc.name,
      file: host.relative(loc.uri),
      startLine: loc.line + 1,
      endLine: loc.endLine + 1,
      source: lines.slice(loc.line, loc.endLine + 1).join('\n'),
    });
  }));

  server.registerTool('qsp_find_references', {
    title: 'Find QSP references',
    description: 'Find where a location, variable or object is defined and used across the project '
      + '(gt/goto/gosub/xgoto/@calls for locations, reads and writes for variables, addobj/delobj for objects).',
    inputSchema: {
      kind: z.enum(['location', 'variable', 'object']),
      name: z.string().describe('Name without a $/#/% type prefix for variables'),
    },
    annotations: { readOnlyHint: true },
  }, ({ kind, name }) => run(host, async () => {
    const { uri, position } = await symbolPosition(host, kind, name);
    const refs: Location[] = (await host.lsp.sendRequest(ReferencesRequest.type, {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    })) ?? [];
    return jsonResult(await describeLocations(host, refs));
  }));

  server.registerTool('qsp_diagnostics', {
    title: 'QSP diagnostics',
    description: 'Errors and warnings the QSP analysis reports, for the whole project or one file.',
    inputSchema: {
      file: z.string().optional().describe('Workspace-relative file; omit for the whole project'),
      minSeverity: z.enum(['error', 'warning', 'info', 'hint']).default('warning'),
    },
    annotations: { readOnlyHint: true },
  }, ({ file, minSeverity }) => run(host, async () => {
    const limit = { error: 1, warning: 2, info: 3, hint: 4 }[minSeverity];
    const only = file !== undefined ? host.uriOf(host.resolve(file)) : undefined;
    const result = [];
    for (const [uri, list] of host.allDiagnostics()) {
      if (only ? uri !== only : !uri.startsWith('file:')) continue;
      for (const d of list) {
        if ((d.severity ?? DiagnosticSeverity.Error) <= limit) result.push(describeDiagnostic(host, uri, d));
      }
    }
    result.sort((a, b) => (a.file ?? '').localeCompare(b.file ?? '') || a.line - b.line);
    return jsonResult(result);
  }));

  server.registerTool('qsp_check_code', {
    title: 'Check QSP code',
    description: 'Analyze QSP code that is not saved anywhere and return its diagnostics, e.g. before writing it to a file. '
      + 'Code without a `# name` header is checked as the body of one location. The project\'s locations are '
      + 'known, so references to them resolve.',
    inputSchema: { code: z.string() },
    annotations: { readOnlyHint: true },
  }, ({ code }) => run(host, async () => {
    const wrap = !/^\s*#/.test(code);
    const text = wrap ? `# __qsp_check__\n${code}\n---\n` : code;
    const diagnostics = await host.checkText(text);
    return jsonResult(diagnostics.map(d => describeDiagnostic(host, '', d, wrap ? -1 : 0)));
  }));

  server.registerTool('qsp_lookup_builtin', {
    title: 'Look up a QSP builtin',
    description: 'Documentation of a QSP statement, function or system variable: signature and description.',
    inputSchema: { name: z.string().describe('e.g. "addobj", "$str", "len", "usehtml"') },
    annotations: { readOnlyHint: true },
  }, ({ name }) => run(host, async () => {
    const b = lookupBuiltin(name.trim());
    if (!b) throw new Error(`"${name}" is not a QSP builtin`);
    return jsonResult(describeBuiltin(b));
  }, { sync: false }));

  server.registerTool('qsp_list_variables', {
    title: 'List QSP variables',
    description: 'Variables used in the project, with where each is first defined (or used) and whether it is local.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, () => run(host, async () => {
    const items = await host.lsp.sendRequest<VariableItem[]>('qsp/listVariables', { uri: host.rootUri });
    return jsonResult(items.map(v => ({
      name: v.name, prefixes: v.prefixes, local: v.isLocal, defined: v.isDefined,
      file: host.relative(v.uri), line: v.line + 1,
    })));
  }));

  server.registerTool('qsp_list_objects', {
    title: 'List QSP objects',
    description: 'Inventory objects the project adds or refers to (addobj/delobj/…), with where each is defined.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, () => run(host, async () => {
    const items = await host.lsp.sendRequest<NamedItem[]>('qsp/listObjects', { uri: host.rootUri });
    return jsonResult(items.map(o => ({ name: o.name, defined: o.isDefined, file: host.relative(o.uri), line: o.line + 1 })));
  }));

  server.registerResource('builtins', 'qsp://builtins', {
    title: 'QSP builtins reference',
    description: 'Every QSP statement, function and system variable with its signature and description.',
    mimeType: 'text/markdown',
  }, (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'text/markdown',
      text: ALL_BUILTINS.map(b => `### ${b.name} (${b.kind})\n${b.signature ? '`' + b.signature + '`\n\n' : ''}${b.description}`).join('\n\n'),
    }],
  }));
}
