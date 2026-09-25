/**
 * Unit tests for `perLocationCacheKeys` — see its doc comment in
 * serverUtils.ts for the bug it fixes: `perLocationCache` used to be
 * keyed by plain `loc.nameLower`, which collapses two locations sharing
 * a name onto the same cache slot. That permanently disabled
 * `tryIncrementalPerLocationUpdate` for the rest of the file's editing
 * session (`currentIndex.length !== prevCache.size` never becomes
 * false again), silently dropped/leaked one duplicate's cache entry in
 * the full-analysis path, and made `buildTokensFromCache` /
 * hover / document-highlight resolve every duplicate past the first
 * against the wrong location's cached data.
 */
import { describe, it, expect } from 'vitest';
import { perLocationCacheKeys } from '../src/server/serverUtils';
import { buildLocationIndex } from '../src/common/locations';

describe('perLocationCacheKeys', () => {
  it('returns plain nameLower for a file with no duplicate names (backward-compatible)', () => {
    const idx = buildLocationIndex(`# alpha\npl 1\n---\n# beta\npl 2\n---\n# gamma\npl 3\n---\n`);
    expect(perLocationCacheKeys(idx)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('gives each duplicate-named location a distinct key', () => {
    const idx = buildLocationIndex(`# dup\npl 1\n---\n# other\npl 2\n---\n# dup\npl 3\n---\n`);
    const keys = perLocationCacheKeys(idx);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3); // all distinct — no collision
    expect(keys[0]).toBe('dup');         // first occurrence keeps the plain key
    expect(keys[1]).toBe('other');
    expect(keys[2]).not.toBe('dup');     // second occurrence gets a distinct key
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('is stable across two identical calls (same array, same content)', () => {
    const idx = buildLocationIndex(`# dup\npl 1\n---\n# dup\npl 2\n---\n# dup\npl 3\n---\n`);
    expect(perLocationCacheKeys(idx)).toEqual(perLocationCacheKeys(idx));
  });

  it('is case-insensitive, matching QSP location name semantics', () => {
    const idx = buildLocationIndex(`# Loc\npl 1\n---\n# LOC\npl 2\n---\n`);
    const keys = perLocationCacheKeys(idx);
    // Both fold to the same nameLower, so they're treated as the same
    // duplicate-name pair as `# loc` / `# loc` would be.
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toBe('loc');
  });

  it('handles three-or-more-way duplicates with all-distinct keys', () => {
    const idx = buildLocationIndex(`# a\npl 1\n---\n# a\npl 2\n---\n# a\npl 3\n---\n# a\npl 4\n---\n`);
    const keys = perLocationCacheKeys(idx);
    expect(new Set(keys).size).toBe(4);
  });
});
