/**
 * The analysis cache end to end: a real language server on a project on
 * disk, analysed without a cache, then with an empty one, then from it.
 *
 * Why
 * ───
 * - A cache may only make opening faster: what the editor shows must be the
 *   same with results read back from disk as with a fresh analysis, across
 *   files (cross-file references, duplicates), with Cyrillic names, exec:
 *   links, syntax errors of closed files and !@qsp-ignore comments.
 * - A file that changed is analysed again; the others still come from the cache.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QspHost } from '../src/mcp/qspHost';
import { loadWasm } from './testHelpers';

const FILES: Record<string, string> = {
  'main.qsps': [
    '# Прихожая',
    "gs 'Кухня', 1",
    "gt 'нет_такой'",
    '*pl счёт',
    "*pl '<a href=\"exec:gt ''Кухня''\">на кухню</a>'",
    '--- Прихожая ---',
    '',
  ].join('\n'),
  'rooms/kitchen.qsps': [
    '# Кухня',
    'local счёт = args[0]',
    "$имя = 'Алиса'",
    '!@qsp-ignore unusedVariables',
    'никто = 1',
    '--- Кухня ---',
    '',
    '# прихожая',
    '--- прихожая ---',
    '',
  ].join('\n'),
  'broken.qsps': '# Сломано\nif x = 1\n  *pl 1\n--- Сломано ---\n',
};

async function analyse(dir: string, cacheDir?: string) {
  const log: string[] = [];
  const host = new QspHost(dir, { wasmLoader: loadWasm }, m => log.push(m), cacheDir);
  await host.start();
  const diagnostics = [...host.allDiagnostics()]
    .map(([uri, list]) => [path.relative(dir, new URL(uri).pathname), list] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  host.dispose();
  return { diagnostics, cacheLine: log.find(l => l.includes('Analysis cache:')) };
}

describe('analysis cache', () => {
  it('gives the same diagnostics as a fresh analysis, and re-analyses only changed files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-cache-e2e-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-cache-dir-'));
    try {
      for (const [rel, text] of Object.entries(FILES)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
      }
      const fresh = await analyse(dir);
      expect(fresh.diagnostics.flatMap(([, l]) => l).length).toBeGreaterThan(3);
      expect(fresh.cacheLine).toBeUndefined();

      const cold = await analyse(dir, cacheDir);
      expect(cold.cacheLine).toMatch(/0 of 3 project files read from it, 3 analysed/);
      expect(fs.readdirSync(cacheDir).filter(f => f.endsWith('.bin'))).toHaveLength(3);

      const warm = await analyse(dir, cacheDir);
      expect(warm.cacheLine).toMatch(/3 of 3 project files read from it, 0 analysed/);
      expect(cold.diagnostics).toEqual(fresh.diagnostics);
      expect(warm.diagnostics).toEqual(fresh.diagnostics);

      fs.appendFileSync(path.join(dir, 'broken.qsps'), "# Новая\ngt 'Прихожая'\n--- Новая ---\n");
      const changed = await analyse(dir, cacheDir);
      expect(changed.cacheLine).toMatch(/2 of 3 project files read from it, 1 analysed/);
      expect(changed.diagnostics).toEqual((await analyse(dir)).diagnostics);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  }, 60_000);
});
