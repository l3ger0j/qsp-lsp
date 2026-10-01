/**
 * Location conflicts across a build's sources.
 *
 * Why
 * ───
 * - A player reaches only one of two same-named locations, and `inclib`
 *   skips a library location the game already has, so the build must stop
 *   and say where every copy is.
 * - Names compare case-insensitively, Cyrillic included, as in QSP.
 * - A `#` or `---` inside a string is not a location.
 */
import { describe, it, expect } from 'vitest';
import { findLocationConflicts, locationConflictMessage } from '../src/common/locationConflicts';

describe('findLocationConflicts', () => {
  it('finds nothing when every name is unique', () => {
    expect(findLocationConflicts([
      { relPath: 'main.qsps', text: '# start\n*pl 1\n--- start ---\n' },
      { relPath: 'libs/dialogs.qsps', text: '# dialogs_init\n--- dialogs_init ---\n' },
    ])).toEqual([]);
  });

  it('finds a name repeated in another file, with 1-based lines', () => {
    expect(findLocationConflicts([
      { relPath: 'main.qsps', text: '# start\n--- start ---\n\n# menu\n--- menu ---\n' },
      { relPath: 'libs/dialogs.qsps', text: '# menu\n--- menu ---\n' },
    ])).toEqual([{
      name: 'menu',
      places: [{ relPath: 'main.qsps', line: 4 }, { relPath: 'libs/dialogs.qsps', line: 1 }],
    }]);
  });

  it('compares names case-insensitively, Cyrillic too', () => {
    const conflicts = findLocationConflicts([
      { relPath: 'main.qsps', text: '# Прихожая\n--- Прихожая ---\n' },
      { relPath: 'rooms.qsps', text: '# ПРИХОЖАЯ\n--- ПРИХОЖАЯ ---\n' },
    ]);
    expect(conflicts.map(c => c.name)).toEqual(['Прихожая']);
    expect(conflicts[0].places.map(p => p.relPath)).toEqual(['main.qsps', 'rooms.qsps']);
  });

  it('finds a name repeated within one file', () => {
    const conflicts = findLocationConflicts([
      { relPath: 'main.qsps', text: '# a\n--- a ---\n# A\n--- A ---\n' },
    ]);
    expect(conflicts).toEqual([{ name: 'a', places: [{ relPath: 'main.qsps', line: 1 }, { relPath: 'main.qsps', line: 3 }] }]);
  });

  it('ignores a header-like line inside a multi-line string', () => {
    expect(findLocationConflicts([
      { relPath: 'main.qsps', text: "# start\n*pl '\n# start\n'\n--- start ---\n" },
    ])).toEqual([]);
  });
});

describe('locationConflictMessage', () => {
  it('is undefined without conflicts', () => {
    expect(locationConflictMessage([])).toBeUndefined();
  });

  it('names every place on one line', () => {
    const message = locationConflictMessage([{
      name: 'menu',
      places: [{ relPath: 'main.qsps', line: 4 }, { relPath: 'libs/dialogs.qsps', line: 1 }],
    }])!;
    expect(message).not.toContain('\n');
    expect(message).toContain('"menu" (main.qsps:4, libs/dialogs.qsps:1)');
  });

  it('lists five conflicts and counts the rest', () => {
    const conflicts = Array.from({ length: 8 }, (_, i) => ({
      name: `loc${i}`,
      places: [{ relPath: 'a.qsps', line: 1 }, { relPath: 'b.qsps', line: 1 }],
    }));
    const message = locationConflictMessage(conflicts)!;
    expect(message).toContain('"loc4"');
    expect(message).not.toContain('"loc5"');
    expect(message).toMatch(/and 3 more$/);
  });
});
