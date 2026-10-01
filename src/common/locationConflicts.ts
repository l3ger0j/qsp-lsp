// ── Location conflicts ───────────────────────────────────────────────
//
// Locations that share a name across everything a build writes. A player
// reaches only one of them without a word (`inclib` skips a library
// location whose name the game already has), so the build refuses instead
// of producing a game that behaves differently from its source. Pure, for
// the client and the MCP server alike.

import { buildLocationIndex } from './locations';

/** One source file of a build, with its text already read. */
export interface ConflictSource {
  relPath: string;
  text: string;
}

/** A location name defined more than once, with every place it is defined. */
export interface LocationConflict {
  name: string;
  places: Array<{ relPath: string; line: number }>;
}

/**
 * Location names defined more than once across `sources`, compared
 * case-insensitively as QSP does. Places keep source order; `line` is
 * 1-based. Conflicts come in the order of their first definition.
 */
export function findLocationConflicts(sources: readonly ConflictSource[]): LocationConflict[] {
  const byName = new Map<string, LocationConflict>();
  for (const { relPath, text } of sources) {
    for (const loc of buildLocationIndex(text)) {
      let conflict = byName.get(loc.nameLower);
      if (!conflict) {
        conflict = { name: loc.name, places: [] };
        byName.set(loc.nameLower, conflict);
      }
      conflict.places.push({ relPath, line: loc.startLine + 1 });
    }
  }
  return [...byName.values()].filter(c => c.places.length > 1);
}

// Enough to see the pattern in a one-line notification; the editor's
// diagnostics mark every one.
const MAX_LISTED = 5;

/** The error a build stops with, on one line; undefined when there is no conflict. */
export function locationConflictMessage(conflicts: readonly LocationConflict[]): string | undefined {
  if (conflicts.length === 0) return undefined;
  const listed = conflicts.slice(0, MAX_LISTED).map(c =>
    `"${c.name}" (${c.places.map(p => `${p.relPath}:${p.line}`).join(', ')})`);
  const more = conflicts.length > MAX_LISTED ? ` and ${conflicts.length - MAX_LISTED} more` : '';
  return `Several locations share a name, and the player would reach only one of each: ${listed.join('; ')}${more}`;
}
