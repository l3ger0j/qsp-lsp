// ── Project source files ─────────────────────────────────────────────
//
// How a project's source files are read into one game text, shared by the
// VS Code client and the MCP server so both build byte-identical games.

/** Strip a BOM and normalise line endings to LF. */
export function normalizeText(text: string): string {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Combine source texts into one. Each text ends with a newline and texts
 * are separated by a blank line, so the last `---` of one file and the
 * first `#` of the next are never on the same line.
 */
export function joinSources(texts: string[]): string {
  return texts
    .map(t => {
      const text = normalizeText(t);
      return text.endsWith('\n') ? text : text + '\n';
    })
    .join('\n');
}

/** A source file as `orderSourceFiles` sees it. */
export interface SourceFile {
  /** Workspace-relative, `/`-separated; what `txt2gam.json` globs match. */
  relPath: string;
  /**
   * Sort key within one glob's matches. The client sorts by the file's URI
   * string, so passing the same string (vscode-uri's `URI.file(p).toString()`)
   * keeps the order identical, including for Cyrillic and spaces.
   */
  sortKey: string;
}

/**
 * Order source files the way `txt2gam.json` describes. With `patterns`,
 * each glob's matches are sorted and appended, and a file matched by an
 * earlier glob is not repeated; files no glob matches are left out.
 * Without them (absent or empty), all files are sorted.
 */
export function orderSourceFiles<T extends SourceFile>(
  files: T[],
  patterns: string[] | undefined,
  matches: (pattern: string, relPath: string) => boolean,
): T[] {
  const byKey = (a: T, b: T) => a.sortKey.localeCompare(b.sortKey);
  if (!patterns || patterns.length === 0) return [...files].sort(byKey);

  const seen = new Set<T>();
  const result: T[] = [];
  for (const pattern of patterns) {
    const hits = files.filter(f => !seen.has(f) && matches(pattern, f.relPath)).sort(byKey);
    for (const f of hits) {
      seen.add(f);
      result.push(f);
    }
  }
  return result;
}
