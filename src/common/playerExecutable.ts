// ── Player executable ────────────────────────────────────────────────
//
// Pure helpers for the `playerExecutable` field of txt2gam.json. Kept free
// of `vscode` so they can be unit-tested; runGame.ts resolves the result
// against the workspace root and falls back to the VS Code setting.

/**
 * Pick the player for this OS from a txt2gam.json `playerExecutable` value:
 * either one path, or an object keyed by Node's `process.platform`
 * (`win32`, `darwin`, `linux`). The object form exists because txt2gam.json
 * is committed and shared, and a Windows path is useless on Linux.
 * Returns undefined for a missing, blank or malformed value, and for an
 * object with no entry for `platform`, so the caller can fall back.
 */
export function pickPlayerExecutable(value: unknown, platform: string): string | undefined {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[platform]
    : value;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/**
 * How a player path from txt2gam.json is resolved: `absolute` is used as is,
 * `command` is a bare name (no path separator) looked up on PATH, like the
 * setting allows, and `relative` is resolved against the workspace root so a
 * player shipped in the repository works from any checkout location.
 */
export function classifyPlayerPath(path: string): 'absolute' | 'command' | 'relative' {
  if (path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path)) return 'absolute';
  if (!/[\\/]/.test(path)) return 'command';
  return 'relative';
}
