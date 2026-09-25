// ── Build plan ───────────────────────────────────────────────────────
//
// Pure helpers for how a project is turned into .qsp files. Kept free of
// `vscode` so they can be unit-tested; the client wires them to
// txt2gam.json and VS Code settings.

/**
 * `single` combines every source file into one .qsp (the output path comes
 * from txt2gam.json). `perFile` encodes each source file into its own .qsp
 * next to it; the game loads the extra modules itself with `inclib`.
 */
export type BuildMode = 'single' | 'perFile';

const BUILD_MODES: readonly BuildMode[] = ['single', 'perFile'];

function isBuildMode(value: unknown): value is BuildMode {
  return typeof value === 'string' && (BUILD_MODES as readonly string[]).includes(value);
}

/**
 * Pick the build mode: txt2gam.json's `buildMode` wins over the
 * `qsp.game.buildMode` setting, which wins over `single`. Unknown values
 * (a typo in hand-edited JSON) are skipped rather than trusted.
 */
export function resolveBuildMode(fileValue: unknown, settingValue: unknown): BuildMode {
  if (isBuildMode(fileValue)) return fileValue;
  if (isBuildMode(settingValue)) return settingValue;
  return 'single';
}

const SOURCE_EXT_RE = /\.(qsps|qsrc)$/i;

/** Output path for one source file in `perFile` mode: same folder and name, `.qsp` extension. */
export function perFileOutputPath(sourcePath: string): string {
  return SOURCE_EXT_RE.test(sourcePath)
    ? sourcePath.replace(SOURCE_EXT_RE, '.qsp')
    : sourcePath + '.qsp';
}

/**
 * Source files that would be written to the same .qsp in `perFile` mode,
 * e.g. `a.qsps` and `a.qsrc` in one folder. Paths are compared
 * case-insensitively because Windows and macOS file systems are, so
 * `A.qsps` and `a.qsrc` would overwrite each other there too.
 */
export function findOutputCollisions(sourcePaths: string[]): Array<{ output: string; sources: string[] }> {
  const byOutput = new Map<string, { output: string; sources: string[] }>();
  for (const source of sourcePaths) {
    const output = perFileOutputPath(source);
    const key = output.toLowerCase();
    let entry = byOutput.get(key);
    if (!entry) { entry = { output, sources: [] }; byOutput.set(key, entry); }
    entry.sources.push(source);
  }
  return [...byOutput.values()].filter(e => e.sources.length > 1);
}

/**
 * Put `entry` first, keeping the rest in their current order. Without an
 * entry (the user dismissed the picker), files at the workspace root go
 * before files in subfolders: a guess that the main game sits at the root
 * and modules live in folders. Paths are workspace-relative with `/`.
 */
export function orderForEntryPoint(relPaths: string[], entry?: string): string[] {
  if (entry !== undefined && relPaths.includes(entry)) {
    return [entry, ...relPaths.filter(p => p !== entry)];
  }
  const atRoot = relPaths.filter(p => !p.includes('/'));
  const nested = relPaths.filter(p => p.includes('/'));
  return [...atRoot, ...nested];
}

// ── Main file ────────────────────────────────────────────────────────

/**
 * How the setup wizard picks the main file when neither txt2gam.json nor
 * the `qsp.game.mainFile` setting names one: `ask` shows a picker and falls
 * back to `root` when it is dismissed; `root` goes straight to root-first order.
 */
export type MainFileStrategy = 'ask' | 'root';

export function resolveMainFileStrategy(settingValue: unknown): MainFileStrategy {
  return settingValue === 'root' ? 'root' : 'ask';
}

/** The main-file pattern: txt2gam.json's `mainFile`, then the setting. Blank values don't count. */
export function resolveMainFilePattern(fileValue: unknown, settingValue: unknown): string | undefined {
  for (const v of [fileValue, settingValue]) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

/**
 * Index of the main file in `relPaths` (workspace-relative, `/`-separated,
 * in build order). `pattern` is a regular expression searched in each path,
 * case-insensitively; the first match in order wins and `matchCount` tells
 * the caller whether it was ambiguous. Throws when the pattern is invalid or
 * matches nothing: an explicitly configured main file must not be ignored.
 */
export function findMainFile(relPaths: string[], pattern: string): { index: number; matchCount: number } {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch (err) {
    throw new Error(`mainFile "${pattern}" is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`);
  }
  const matches = relPaths.flatMap((p, i) => (re.test(p) ? [i] : []));
  if (matches.length === 0) {
    throw new Error(`mainFile "${pattern}" matches none of the project's source files`);
  }
  return { index: matches[0], matchCount: matches.length };
}

/** A `mainFile` pattern that matches exactly this workspace-relative path. */
export function exactPathPattern(relPath: string): string {
  return '^' + relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
}

/** `items` with the element at `index` moved to the front; the rest keep their order. */
export function moveToFront<T>(items: T[], index: number): T[] {
  return [items[index], ...items.slice(0, index), ...items.slice(index + 1)];
}
