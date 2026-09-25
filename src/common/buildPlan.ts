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
