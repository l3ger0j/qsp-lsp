/**
 * Library catalogs (libraries.json).
 *
 * Why
 * ───
 * - A catalog is written by hand in someone's repository: a bad entry must
 *   be skipped with a reason, not break the whole list.
 * - File paths are relative to the catalog, so a repository can move.
 * - A newer catalog format is refused rather than misread.
 * - Requirements are installed first, and a missing or looping one stops
 *   the install before anything is written.
 */
import { describe, it, expect } from 'vitest';
import {
  compareVersions, installOrder, localizedDescription, mergeCatalogs, parseCatalog, type CatalogLibrary,
} from '../src/common/libraryCatalog';

const URL_A = 'https://raw.githubusercontent.com/me/qsp-libs/main/libraries.json';
const SHA = 'a'.repeat(64);

const lib = (fields: Record<string, unknown>) => ({ version: '1.0.0', file: `${fields.id}/${fields.id}.qsps`, sha256: SHA, ...fields });

describe('parseCatalog', () => {
  it('reads an entry and resolves its file against the catalog URL', () => {
    const { libraries, problems } = parseCatalog({
      schema: 1,
      libraries: [lib({
        id: 'dialogs', name: 'Диалоги', description: { en: 'Dialogs', RU: 'Диалоги с выбором' },
        sha256: SHA.toUpperCase(), usage: "inclib 'libs/dialogs.qsp'\ngs 'dialogs_init'", requires: ['utils', 3],
      })],
    }, URL_A);
    expect(problems).toEqual([]);
    expect(libraries).toEqual([{
      id: 'dialogs',
      name: 'Диалоги',
      description: { en: 'Dialogs', ru: 'Диалоги с выбором' },
      version: '1.0.0',
      url: 'https://raw.githubusercontent.com/me/qsp-libs/main/dialogs/dialogs.qsps',
      sha256: SHA,
      usage: "inclib 'libs/dialogs.qsp'\ngs 'dialogs_init'",
      requires: ['utils'],
      catalog: URL_A,
    }]);
  });

  it('fills in a name, an English description and an inclib usage', () => {
    const [entry] = parseCatalog({ libraries: [lib({ id: 'ui', description: 'Menus' })] }, URL_A).libraries;
    expect(entry).toMatchObject({ name: 'ui', description: { en: 'Menus' }, usage: "inclib 'libs/ui.qsp'", requires: [] });
  });

  it('skips bad entries with a reason and keeps the good ones', () => {
    const { libraries, problems } = parseCatalog({
      libraries: [
        lib({ id: '../evil' }),
        lib({ id: 'nover', version: '' }),
        lib({ id: 'notqsps', file: 'x.qsp' }),
        lib({ id: 'badsum', sha256: 'abc' }),
        lib({ id: 'good' }),
        lib({ id: 'GOOD' }),
        'nonsense',
      ],
    }, URL_A);
    expect(libraries.map(l => l.id)).toEqual(['good']);
    expect(problems).toEqual([
      expect.stringContaining('"id" must be'),
      expect.stringContaining('"nover": no "version"'),
      expect.stringContaining('"notqsps": "file" must name a .qsps file'),
      expect.stringContaining('"badsum": "sha256" must be 64 hex digits'),
      expect.stringContaining('"GOOD": listed twice'),
      expect.stringContaining('library #7'),
    ]);
  });

  it('refuses a newer catalog format and things that are not catalogs', () => {
    expect(parseCatalog({ schema: 2, libraries: [lib({ id: 'x' })] }, URL_A)).toEqual({
      libraries: [], problems: [expect.stringContaining('needs a newer QSP extension')],
    });
    expect(parseCatalog(null, URL_A).problems).toEqual([expect.stringContaining('not a libraries.json catalog')]);
    expect(parseCatalog({}, URL_A).problems).toEqual([expect.stringContaining('no "libraries" list')]);
  });
});

describe('mergeCatalogs', () => {
  it('keeps the first catalog\'s library when two offer the same id', () => {
    const a = parseCatalog({ libraries: [lib({ id: 'dialogs' })] }, URL_A);
    const b = parseCatalog({ libraries: [lib({ id: 'Dialogs' }), lib({ id: 'ui' })] }, 'https://example.org/libraries.json');
    const merged = mergeCatalogs([a, b]);
    expect(merged.libraries.map(l => `${l.id}@${l.catalog}`)).toEqual([`dialogs@${URL_A}`, 'ui@https://example.org/libraries.json']);
    expect(merged.problems).toEqual([expect.stringContaining('"Dialogs" is also in')]);
  });
});

describe('localizedDescription', () => {
  const description = { en: 'Dialogs', ru: 'Диалоги' };
  it('picks the editor language, then English, then anything', () => {
    expect(localizedDescription(description, 'ru')).toBe('Диалоги');
    expect(localizedDescription(description, 'ru-RU')).toBe('Диалоги');
    expect(localizedDescription(description, 'de')).toBe('Dialogs');
    expect(localizedDescription({ uk: 'Діалоги' }, 'de')).toBe('Діалоги');
    expect(localizedDescription({}, 'en')).toBe('');
  });
});

describe('compareVersions', () => {
  it('compares numeric parts as numbers', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('0.9', '1.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta', '1.0.0-rc')).toBe(-1);
  });
});

describe('installOrder', () => {
  const catalog = (entries: Array<Record<string, unknown>>): CatalogLibrary[] =>
    parseCatalog({ libraries: entries.map(lib) }, URL_A).libraries;

  it('puts requirements first and skips installed ones', () => {
    const libs = catalog([
      { id: 'dialogs', requires: ['ui', 'utils'] },
      { id: 'ui', requires: ['utils'] },
      { id: 'utils' },
    ]);
    expect(installOrder('dialogs', libs, new Set()).map(l => l.id)).toEqual(['utils', 'ui', 'dialogs']);
    expect(installOrder('dialogs', libs, new Set(['UTILS'])).map(l => l.id)).toEqual(['ui', 'dialogs']);
  });

  it('reinstalls the library itself even when it is installed (an update)', () => {
    expect(installOrder('utils', catalog([{ id: 'utils' }]), new Set(['utils'])).map(l => l.id)).toEqual(['utils']);
  });

  it('stops on a missing requirement or a loop', () => {
    expect(() => installOrder('dialogs', catalog([{ id: 'dialogs', requires: ['ghost'] }]), new Set()))
      .toThrow('Library "dialogs" needs "ghost", which no catalog offers');
    expect(() => installOrder('a', catalog([{ id: 'a', requires: ['b'] }, { id: 'b', requires: ['a'] }]), new Set()))
      .toThrow('loop: a → b → a');
    expect(() => installOrder('nope', [], new Set())).toThrow('No catalog offers the library "nope"');
  });
});
