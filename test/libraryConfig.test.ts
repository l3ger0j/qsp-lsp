/**
 * The `libraries` section of txt2gam.json.
 *
 * Why
 * ───
 * - Each installed library is built into a .qsp of its own for `inclib`,
 *   so the game's build must leave its source out (else the game holds the
 *   library twice).
 * - Ids come from a hand-editable file and become paths: none may point
 *   outside the libs folder.
 */
import { describe, it, expect } from 'vitest';
import { installedLibraries, isValidLibraryId, withoutLibraries } from '../src/common/libraryConfig';

const entry = { version: '1.0.0', sha256: 'ab', catalog: 'https://example.org/libraries.json' };

describe('isValidLibraryId', () => {
  it('accepts file-name-safe ids and refuses the rest', () => {
    expect(['dialogs', 'ui_menu', 'inv-2', 'a.b'].every(isValidLibraryId)).toBe(true);
    expect(['', '../x', 'a/b', 'a\\b', '.hidden', 'a..b', 'диалоги'].some(isValidLibraryId)).toBe(false);
  });
});

describe('installedLibraries', () => {
  it('gives each library its source and output path in libs', () => {
    expect(installedLibraries({ installed: { dialogs: entry } })).toEqual([{
      id: 'dialogs', ...entry, sourcePath: 'libs/dialogs.qsps', outputPath: 'libs/dialogs.qsp',
    }]);
    expect(installedLibraries(undefined)).toEqual([]);
    expect(installedLibraries({})).toEqual([]);
  });

  it('refuses an id that would leave the folder', () => {
    expect(() => installedLibraries({ installed: { '../main': entry } })).toThrow(/not a valid library name/);
  });
});

describe('withoutLibraries', () => {
  it('drops installed library sources, comparing paths case-insensitively', () => {
    const libs = installedLibraries({ installed: { dialogs: entry } });
    const paths = ['main.qsps', 'Libs/Dialogs.qsps', 'libs\\dialogs.qsps', 'libs/mine.qsps'];
    expect(withoutLibraries(paths, p => p, libs)).toEqual(['main.qsps', 'libs/mine.qsps']);
  });
});
