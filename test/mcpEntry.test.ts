/**
 * out/mcp/server.js, the MCP entry point, must load on any Node.js and
 * refuse one older than 18 with a message: an MCP client started with an
 * old `node` from PATH otherwise shows only "Connection closed", because
 * the real server fails with a SyntaxError before it can say anything.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'server.js'), 'utf8');

function runEntry(nodeVersion: string) {
  const stderr: string[] = [];
  const required: string[] = [];
  let exitCode: number | undefined;
  const fakeProcess = {
    versions: { node: nodeVersion },
    execPath: '/usr/bin/node',
    stderr: { write: (s: string) => { stderr.push(s); } },
    exit: (code: number) => { exitCode = code; },
  };
  new Function('process', 'require', SOURCE)(fakeProcess, (id: string) => { required.push(id); });
  return { stderr: stderr.join(''), required, exitCode };
}

describe('MCP entry point', () => {
  it('explains and exits on Node older than 18', () => {
    const r = runEntry('12.22.9');
    expect(r.exitCode).toBe(1);
    expect(r.required).toEqual([]);
    expect(r.stderr).toContain('needs Node.js 18 or newer');
    expect(r.stderr).toContain('12.22.9');
    expect(r.stderr).toContain('/usr/bin/node');
  });

  it('loads the server on Node 18 and newer', () => {
    for (const v of ['18.0.0', '22.21.0', '24.1.0']) {
      expect(runEntry(v)).toEqual({ stderr: '', required: ['./main.js'], exitCode: undefined });
    }
  });

  it('parses as ES5, so an old Node can run it far enough to explain', () => {
    // No const/let, arrow functions, template literals, classes or `?.`.
    const code = SOURCE.replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\\]|\\\\.)*'/g, "''");
    expect(code).not.toMatch(/\b(const|let|class)\b|=>|`|\?\./);
  });
});
