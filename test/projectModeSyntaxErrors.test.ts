/**
 * Syntax errors of project files that are not open in the editor.
 *
 * Why
 * ───
 * The project scan parses every file but frees each tree right away, so
 * the diagnostics of a closed file had no syntax errors: a broken `if` in
 * a file nobody opened didn't show in Problems (or to an MCP agent) until
 * the file was opened. The scan now keeps the errors on the file's state,
 * including for large files parsed one location at a time, where each
 * location's errors must land on the right lines of the file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import type { Connection, Diagnostic, TextDocuments } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { ProjectModeService } from '../src/server/projectMode';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import type { DocumentState } from '../src/server/lspFeatures';
import type { FsProvider } from '../src/server/serverUtils';
import { ALL_DIAGS_OFF, WASM_PATH } from './testHelpers';

function recordingConnection(published: Map<string, Diagnostic[]>): Connection {
  return {
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    sendDiagnostics: (p: { uri: string; diagnostics: Diagnostic[] }) => { published.set(p.uri, p.diagnostics); },
  } as unknown as Connection;
}

function memoryFs(files: Map<string, string>): FsProvider {
  return {
    async readFile(p: string) { return files.get(p)!; },
    async *findFiles(dir: string) { for (const p of files.keys()) if (p.startsWith(dir)) yield p; },
    pathToUri: (p: string) => `file://${p}`,
    uriToPath: (u: string) => u.replace('file://', ''),
  };
}

const noDocuments = { get: () => undefined, all: () => [] } as unknown as TextDocuments<TextDocument>;

describe('project mode: syntax errors of closed files', () => {
  const tsParser = new QspTreeSitterParser();
  beforeAll(async () => { await tsParser.init(async () => fs.readFileSync(WASM_PATH)); });

  async function scan(files: Map<string, string>) {
    const published = new Map<string, Diagnostic[]>();
    const project = new ProjectModeService(recordingConnection(published), noDocuments, new Map<string, DocumentState>(), tsParser);
    project.workspaceFolders = ['/proj'];
    await project.init(memoryFs(files), 'utf8', () => new Map(), () => [], { ...ALL_DIAGS_OFF, maxErrorsPerLocation: 1000 });
    return published;
  }

  it('publishes the syntax error of a file that is not open', async () => {
    const published = await scan(new Map([
      ['/proj/ok.qsps', '# ok\n*pl 1\n---\n'],
      ['/proj/broken.qsps', '# broken\nif x = 1\n  *pl 1\nend\n---\n'],
    ]));
    const errors = published.get('file:///proj/broken.qsps') ?? [];
    expect(errors).toEqual([expect.objectContaining({ message: expect.stringContaining("Missing ':'") })]);
    expect(errors[0].range.start.line).toBe(1);
    expect(published.get('file:///proj/ok.qsps')).toEqual([]);
  });

  it('puts the errors of a file parsed per location on the right lines', async () => {
    const pad = '! ' + 'x'.repeat(120) + '\n';
    const big = `# pad\n${pad.repeat(Math.ceil(510_000 / pad.length))}---\n# broken\nif x = 1\n  *pl 1\nend\n---\n`;
    expect(big.length).toBeGreaterThan(500_000);
    const brokenIfLine = big.split('\n').indexOf('if x = 1');

    const published = await scan(new Map([['/proj/big.qsps', big]]));
    const errors = published.get('file:///proj/big.qsps') ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0].range.start.line).toBe(brokenIfLine);
  }, 30_000);
});
