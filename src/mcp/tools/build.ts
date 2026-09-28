// ── Build tool ───────────────────────────────────────────────────────
//
// qsp_build: encode the project into .qsp the way the extension's Export
// command does, following txt2gam.json and the qsp.game.* settings. It
// shares the ordering, main-file and output rules with the client
// (src/common/buildPlan.ts, projectFiles.ts, txt2gamCore.ts), so both
// produce the same bytes.

import * as fs from 'fs';
import * as path from 'path';
import picomatch from 'picomatch';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  findMainFile,
  findOutputCollisions,
  moveToFront,
  orderForEntryPoint,
  perFileOutputPath,
  resolveBuildMode,
  resolveMainFilePattern,
  type BuildMode,
} from '../../common/buildPlan';
import { joinSources, normalizeText, orderSourceFiles } from '../../common/projectFiles';
import { encodeWith, type T2gModule } from '../../common/txt2gamCore';
import { fsProvider } from '../../server/nodeHost';
import { QSP_FILE_EXTENSIONS } from '../../server/serverUtils';
import type { QspHost } from '../qspHost';
import { jsonResult, run } from './result';

interface GameConfig {
  outputFile?: string;
  files?: string[];
  buildMode?: string;
  mainFile?: string;
}

interface Source { abs: string; relPath: string; sortKey: string }

/** A `qsp.*` setting from the workspace's settings.json, flat or nested. */
export function setting(settings: Record<string, unknown>, key: string): unknown {
  if (key in settings) return settings[key];
  let node: unknown = settings;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function readGameConfig(workspaceDir: string): GameConfig | undefined {
  const file = path.join(workspaceDir, 'txt2gam.json');
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as GameConfig;
  } catch (err) {
    throw new Error(`txt2gam.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function projectSources(host: QspHost): Promise<Source[]> {
  const sources: Source[] = [];
  for await (const abs of fsProvider.findFiles(host.workspaceDir, QSP_FILE_EXTENSIONS)) {
    sources.push({ abs, relPath: path.relative(host.workspaceDir, abs).split(path.sep).join('/'), sortKey: host.uriOf(abs) });
  }
  return sources;
}

function sameBytes(file: string, bytes: Uint8Array): 'same' | 'changed' | 'new' {
  if (!fs.existsSync(file)) return 'new';
  const existing = fs.readFileSync(file);
  return Buffer.compare(existing, Buffer.from(bytes)) === 0 ? 'same' : 'changed';
}

export function registerBuildTool(
  server: McpServer,
  host: QspHost,
  loadTxt2gam: () => Promise<T2gModule>,
): void {
  server.registerTool('qsp_build', {
    title: 'Build the QSP game',
    description: 'Encode the project into .qsp game file(s) with txt2gam, like the extension\'s Export command: '
      + 'file order, main file and output come from txt2gam.json and the qsp.game.* settings. In "single" mode '
      + 'all sources become one .qsp; in "perFile" mode each source becomes its own .qsp next to it. '
      + 'Files whose content would not change are not rewritten. Nothing is written if any file fails to encode.',
    inputSchema: {
      buildMode: z.enum(['single', 'perFile']).optional()
        .describe('Override the build mode from txt2gam.json and settings'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, ({ buildMode }) => run(host, async () => {
    const cfg = readGameConfig(host.workspaceDir);
    const s = host.settings;
    const mode: BuildMode = buildMode ?? resolveBuildMode(cfg?.buildMode, setting(s, 'qsp.game.buildMode'));
    const password = (setting(s, 'qsp.game.password') as string | undefined) || undefined;

    let sources = await projectSources(host);
    if (cfg?.files && cfg.files.length > 0) {
      const matchers = new Map(cfg.files.map(p => [p, picomatch(p, { dot: true })]));
      sources = orderSourceFiles(sources, cfg.files, (pattern, rel) => matchers.get(pattern)!(rel));
    } else {
      // Without a file list, a guess the extension also makes: the game
      // starts at the root and modules live in folders.
      const sorted = orderSourceFiles(sources, undefined, () => false);
      const order = orderForEntryPoint(sorted.map(f => f.relPath));
      sources = order.map(rel => sorted.find(f => f.relPath === rel)!);
    }
    if (sources.length === 0) throw new Error('The project has no .qsps/.qsrc source files');

    const mainPattern = resolveMainFilePattern(cfg?.mainFile, setting(s, 'qsp.game.mainFile'));
    if (mainPattern !== undefined) {
      sources = moveToFront(sources, findMainFile(sources.map(f => f.relPath), mainPattern).index);
    }

    const mod = await loadTxt2gam();
    const outputs: Array<{ file: string; bytes: Uint8Array }> = [];
    if (mode === 'single') {
      const configured = cfg?.outputFile ?? `${path.basename(host.workspaceDir)}.qsp`;
      const file = path.isAbsolute(configured) ? configured : path.join(host.workspaceDir, configured);
      outputs.push({ file, bytes: encodeWith(mod, joinSources(sources.map(f => host.readText(f.abs))), { password }) });
    } else {
      const collisions = findOutputCollisions(sources.map(f => f.abs));
      if (collisions.length > 0) {
        const list = collisions.map(c => c.sources.map(p => path.relative(host.workspaceDir, p)).join(' + ')).join('; ');
        throw new Error(`Several source files would be built into the same .qsp: ${list}`);
      }
      for (const f of sources) {
        try {
          outputs.push({ file: perFileOutputPath(f.abs), bytes: encodeWith(mod, normalizeText(host.readText(f.abs)), { password }) });
        } catch (err) {
          throw new Error(`${f.relPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const written = outputs.map(({ file, bytes }) => {
      const status = sameBytes(file, bytes);
      if (status !== 'same') {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
      }
      return {
        file: path.relative(host.workspaceDir, file).split(path.sep).join('/'),
        status: status === 'same' ? 'unchanged' : status === 'new' ? 'created' : 'updated',
        bytes: bytes.byteLength,
      };
    });
    return jsonResult({
      buildMode: mode,
      config: cfg ? 'txt2gam.json' : 'none (all sources, root files first)',
      mainFile: sources[0].relPath,
      sources: sources.map(f => f.relPath),
      outputs: written,
    });
  }));
}
