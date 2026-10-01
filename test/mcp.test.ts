/**
 * The QSP MCP server, end to end: an MCP client talks to the server over
 * an in-memory transport, and the server answers from the real language
 * server running on a temporary project on disk.
 *
 * Why
 * ───
 * - Tools must answer what the editor would (same analysis), with 1-based
 *   lines and case-insensitive names.
 * - The MCP process sees only the disk, so a file an agent changes with its
 *   own tools between calls must be picked up by the next call.
 * - Paths outside the workspace are refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { QspHost } from '../src/mcp/qspHost';
import { createQspMcpServer } from '../src/mcp/mcpServer';
import { decodeWith, type CreateT2gModule } from '../src/common/txt2gamCore';
import { loadWasm } from './testHelpers';

const VENDOR = path.join(__dirname, '..', 'vendor', 'txt2gam');
const loadTxt2gam = async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factory = require(path.join(VENDOR, 'txt2gam.js')) as CreateT2gModule;
  return factory({ wasmBinary: new Uint8Array(fs.readFileSync(path.join(VENDOR, 'txt2gam.wasm'))) });
};

/** An MCP client connected to a server for a fresh temporary project made of `files`. */
async function startMcp(files: Record<string, string | Buffer>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-mcp-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const host = new QspHost(dir, { wasmLoader: loadWasm });
  await host.start();
  const server = createQspMcpServer(host, 'test', { loadTxt2gam });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    return { isError: result.isError === true, text, json: () => JSON.parse(text) };
  };
  const dispose = async () => {
    await client.close();
    host.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, client, call, dispose };
}

const FILES: Record<string, string> = {
  'main.qsps': "# start\nx = len('abc')\ngt 'data'\n--- start ---\n",
  'data/data.qsps': "﻿# data\n$name = 'Алиса'\n*pl $name\n--- data ---\n",
  'errors.qsps': '# broken\nif x = 1\n  *pl 1\nend\n--- broken ---\n',
};

describe('read tools', () => {
  let mcp: Awaited<ReturnType<typeof startMcp>>;
  let dir: string;
  let client: Client;
  let call: typeof mcp.call;
  beforeAll(async () => { mcp = await startMcp(FILES); ({ dir, client, call } = mcp); }, 30_000);
  afterAll(() => mcp?.dispose());

  it('lists every location with its file and 1-based lines', async () => {
    const locations = (await call('qsp_list_locations')).json();
    expect(locations).toEqual(expect.arrayContaining([
      { name: 'start', file: 'main.qsps', startLine: 1, endLine: 4 },
      { name: 'data', file: 'data/data.qsps', startLine: 1, endLine: 4 },
      { name: 'broken', file: 'errors.qsps', startLine: 1, endLine: 5 },
    ]));
    expect((await call('qsp_list_locations', { filter: 'DAT' })).json().map((l: { name: string }) => l.name)).toEqual(['data']);
  });

  it('returns a location\'s source, finding it case-insensitively', async () => {
    const loc = (await call('qsp_get_location', { name: 'DATA' })).json();
    expect(loc).toMatchObject({ name: 'data', file: 'data/data.qsps', startLine: 1 });
    expect(loc.source).toContain("$name = 'Алиса'");
    expect((await call('qsp_get_location', { name: 'nowhere' })).isError).toBe(true);
  });

  it('finds the gt that jumps to a location in another file', async () => {
    const refs = (await call('qsp_find_references', { kind: 'location', name: 'data' })).json();
    expect(refs).toEqual(expect.arrayContaining([{ file: 'main.qsps', line: 3, text: "gt 'data'" }]));
  });

  it('finds a variable\'s writes and reads, given with or without its prefix', async () => {
    for (const name of ['name', '$name']) {
      const refs = (await call('qsp_find_references', { kind: 'variable', name })).json();
      expect(refs.map((r: { line: number }) => r.line).sort()).toEqual([2, 3]);
    }
  });

  it('reports the project\'s diagnostics, and a single file\'s', async () => {
    const all = (await call('qsp_diagnostics', { minSeverity: 'error' })).json();
    expect(all).toEqual(expect.arrayContaining([expect.objectContaining({
      file: 'errors.qsps', line: 2, severity: 'error', message: expect.stringContaining("Missing ':'"),
    })]));
    expect((await call('qsp_diagnostics', { file: 'main.qsps', minSeverity: 'error' })).json()).toEqual([]);
  });

  it('checks unsaved code, with or without a location header', async () => {
    const bad = (await call('qsp_check_code', { code: 'if x = 1\n  *pl 1\nend' })).json();
    expect(bad).toEqual(expect.arrayContaining([expect.objectContaining({ line: 1, message: expect.stringContaining("Missing ':'") })]));
    expect((await call('qsp_check_code', { code: "if x = 1:\n  gt 'data'\nend" })).json()
      .filter((d: { severity: string }) => d.severity === 'error')).toEqual([]);
    expect((await call('qsp_check_code', { code: '# whole\n*pl 1\n---\n' })).json()
      .filter((d: { severity: string }) => d.severity === 'error')).toEqual([]);
  });

  it('documents builtins', async () => {
    expect((await call('qsp_lookup_builtin', { name: 'LEN' })).json()).toMatchObject({ name: expect.stringMatching(/len/i), kind: 'function' });
    expect((await call('qsp_lookup_builtin', { name: 'notabuiltin' })).isError).toBe(true);
    const res = await client.readResource({ uri: 'qsp://builtins' });
    expect((res.contents[0] as { text: string }).text).toMatch(/addobj/i);
  });

  it('refuses a file outside the workspace', async () => {
    const res = await call('qsp_diagnostics', { file: '../elsewhere.qsps' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/outside the workspace/);
  });

  it('sees files created and changed on disk between calls', async () => {
    fs.writeFileSync(path.join(dir, 'new.qsps'), '# новая\n*pl 1\n--- новая ---\n');
    expect((await call('qsp_list_locations')).json().map((l: { name: string }) => l.name)).toContain('новая');

    fs.writeFileSync(path.join(dir, 'main.qsps'), "# start\nif y = 2\n  gt 'data'\nend\n--- start ---\n");
    const diags = (await call('qsp_diagnostics', { file: 'main.qsps', minSeverity: 'error' })).json();
    expect(diags).toEqual([expect.objectContaining({ line: 2, message: expect.stringContaining("Missing ':'") })]);
  });
});

describe('qsp_build', () => {
  const project = {
    'main.qsps': "# start\n*pl 'main'\n--- start ---\n",
    'data/data.qsps': "\uFEFF# data\n*pl 'Данные'\n--- data ---\n",
    'aaa.qsps': "# aaa\n*pl 'first alphabetically'\n--- aaa ---\n",
    'txt2gam.json': JSON.stringify({ outputFile: 'game.qsp', files: ['aaa.qsps', 'main.qsps', 'data/*.qsps'], mainFile: '^main\\.qsps$' }),
  };
  let mcp: Awaited<ReturnType<typeof startMcp>>;
  beforeAll(async () => { mcp = await startMcp(project); }, 30_000);
  afterAll(() => mcp?.dispose());

  it('builds one .qsp in txt2gam.json order with the main file first', async () => {
    const result = (await mcp.call('qsp_build')).json();
    expect(result).toMatchObject({
      buildMode: 'single',
      mainFile: 'main.qsps',
      sources: ['main.qsps', 'aaa.qsps', 'data/data.qsps'],
      outputs: [{ file: 'game.qsp', status: 'created' }],
    });
    const text = decodeWith(await loadTxt2gam(), new Uint8Array(fs.readFileSync(path.join(mcp.dir, 'game.qsp'))));
    const order = ['# start', '# aaa', '# data'].map(h => text.indexOf(h));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('Данные');
  });

  it('leaves an output whose content did not change untouched', async () => {
    const file = path.join(mcp.dir, 'game.qsp');
    const before = fs.statSync(file).mtimeMs;
    await new Promise(r => setTimeout(r, 20));
    expect((await mcp.call('qsp_build')).json().outputs).toEqual([expect.objectContaining({ status: 'unchanged' })]);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('builds each source into its own .qsp in perFile mode', async () => {
    const result = (await mcp.call('qsp_build', { buildMode: 'perFile' })).json();
    expect(result.outputs.map((o: { file: string }) => o.file)).toEqual(['main.qsp', 'aaa.qsp', 'data/data.qsp']);
    expect(fs.existsSync(path.join(mcp.dir, 'data', 'data.qsp'))).toBe(true);
  });

  it('builds an installed library into its own .qsp, outside the game', async () => {
    const withLib = await startMcp({
      'main.qsps': "# start\ninclib 'libs/dialogs.qsp'\ngs 'диалог_init'\n--- start ---\n",
      'libs/dialogs.qsps': "# диалог_init\n*pl 'Диалог'\n--- диалог_init ---\n",
      'libs/mine.qsps': '# mine\n--- mine ---\n',
      'txt2gam.json': JSON.stringify({
        outputFile: 'game.qsp',
        files: ['*.qsps', 'libs/*.qsps'],
        libraries: { installed: { dialogs: { version: '1.0.0', sha256: '', catalog: '' } } },
      }),
    });
    try {
      const result = (await withLib.call('qsp_build')).json();
      expect(result.sources).toEqual(['main.qsps', 'libs/mine.qsps']);
      expect(result.libraries).toEqual(['libs/dialogs.qsps']);
      expect(result.outputs.map((o: { file: string }) => o.file)).toEqual(['game.qsp', 'libs/dialogs.qsp']);
      const t2g = await loadTxt2gam();
      const game = decodeWith(t2g, new Uint8Array(fs.readFileSync(path.join(withLib.dir, 'game.qsp'))));
      expect(game).toContain('# mine');
      expect(game).not.toContain('# диалог_init');
      const lib = decodeWith(t2g, new Uint8Array(fs.readFileSync(path.join(withLib.dir, 'libs', 'dialogs.qsp'))));
      expect(lib).toContain('# диалог_init');

      fs.appendFileSync(path.join(withLib.dir, 'main.qsps'), '\n# Диалог_INIT\n--- Диалог_INIT ---\n');
      const clash = await withLib.call('qsp_build');
      expect(clash.isError).toBe(true);
      expect(clash.text).toContain('"Диалог_INIT" (main.qsps:6, libs/dialogs.qsps:1)');

      fs.rmSync(path.join(withLib.dir, 'libs', 'dialogs.qsps'));
      const missing = await withLib.call('qsp_build');
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('"dialogs" is listed in txt2gam.json, but libs/dialogs.qsps is missing');
    } finally {
      await withLib.dispose();
    }
  }, 30_000);

  it('writes nothing when two files define the same location', async () => {
    const clash = await startMcp({
      'main.qsps': "# start\ngs 'меню'\n--- start ---\n\n# Меню\n*pl 0\n--- Меню ---\n",
      'libs/dialogs.qsps': '﻿# меню\n*pl 1\n--- меню ---\n',
      'txt2gam.json': JSON.stringify({ outputFile: 'game.qsp', mainFile: '^main\\.qsps$' }),
    });
    try {
      for (const buildMode of ['single', 'perFile']) {
        const result = await clash.call('qsp_build', { buildMode });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('"Меню" (main.qsps:5, libs/dialogs.qsps:1)');
      }
      expect(fs.readdirSync(clash.dir).filter(f => f.endsWith('.qsp'))).toEqual([]);
      expect(fs.existsSync(path.join(clash.dir, 'libs', 'dialogs.qsp'))).toBe(false);
    } finally {
      await clash.dispose();
    }
  }, 30_000);
});

describe('edit tools', () => {
  const project = {
    'main.qsps': "# start\n$name = 'Алиса'\ngt 'data'\n--- start ---\n",
    'data/data.qsps': "﻿# data\r\n*pl $name\r\n--- data ---\r\n",
    'fmt.qsps': '# fmt\nif x = 1:\n*pl 1\nend\n--- fmt ---\n',
  };
  let mcp: Awaited<ReturnType<typeof startMcp>>;
  const read = (rel: string) => fs.readFileSync(path.join(mcp.dir, rel));
  beforeAll(async () => { mcp = await startMcp(project); }, 30_000);
  afterAll(() => mcp?.dispose());

  it('shows a rename without writing anything', async () => {
    const before = read('main.qsps');
    const result = (await mcp.call('qsp_rename', { kind: 'location', name: 'DATA', newName: 'данные' })).json();
    expect(result.applied).toBe(false);
    expect(result.files).toEqual(expect.arrayContaining([
      { file: 'main.qsps', changes: [{ line: 3, before: "gt 'data'", after: "gt 'данные'" }] },
      expect.objectContaining({ file: 'data/data.qsps' }),
    ]));
    expect(read('main.qsps').equals(before)).toBe(true);
  });

  it('applies a location rename across files, keeping BOM and line endings', async () => {
    await mcp.call('qsp_rename', { kind: 'location', name: 'data', newName: 'данные', apply: true });
    expect(read('main.qsps').toString('utf8')).toContain("gt 'данные'");
    const data = read('data/data.qsps');
    expect([...data.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(data.toString('utf8')).toContain('# данные\r\n');
    const names = (await mcp.call('qsp_list_locations')).json().map((l: { name: string }) => l.name);
    expect(names).toContain('данные');
    expect(names).not.toContain('data');
  });

  it('renames a variable\'s reads and writes', async () => {
    await mcp.call('qsp_rename', { kind: 'variable', name: '$name', newName: 'hero', apply: true });
    expect(read('main.qsps').toString('utf8')).toContain("$hero = 'Алиса'");
    expect(read('data/data.qsps').toString('utf8')).toContain('*pl $hero');
  });

  it('formats one location', async () => {
    const preview = (await mcp.call('qsp_format_location', { name: 'fmt', tabSize: 2 })).json();
    expect(preview.files).toHaveLength(1);
    await mcp.call('qsp_format_location', { name: 'fmt', tabSize: 2, apply: true });
    expect(read('fmt.qsps').toString('utf8')).toContain('if x = 1:\n  *pl 1\nend');
  });
});

describe('QspHost.isUnchangedSinceSync', () => {
  it('turns false when a file changes after the last sync, and true again after one', async () => {
    const mcp = await startMcp({ 'a.qsps': '# a\n*pl 1\n---\n' });
    try {
      const host = new QspHost(mcp.dir, { wasmLoader: loadWasm });
      await host.start();
      const file = path.join(mcp.dir, 'a.qsps');
      expect(host.isUnchangedSinceSync(file)).toBe(true);
      fs.writeFileSync(file, '# a\n*pl 22\n---\n');
      expect(host.isUnchangedSinceSync(file)).toBe(false);
      await host.sync();
      expect(host.isUnchangedSinceSync(file)).toBe(true);
      host.dispose();
    } finally {
      await mcp.dispose();
    }
  }, 30_000);
});
