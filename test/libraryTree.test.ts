/**
 * The QSP Libraries view model.
 *
 * Why
 * ───
 * - An author must see at a glance which libraries the game has, which
 *   have updates, and which were changed by hand or went missing (the
 *   build stops on a missing one).
 * - Without catalogs, or offline, the view says why instead of being empty.
 */
import { describe, it, expect } from 'vitest';
import { parseCatalog } from '../src/common/libraryCatalog';
import { installedLibraries } from '../src/common/libraryConfig';
import { buildLibraryTree, type InstalledNode, type SectionNode } from '../src/common/libraryTree';

const URL_A = 'https://example.org/libraries.json';
const SHA_1 = '1'.repeat(64);
const SHA_2 = '2'.repeat(64);

const catalog = parseCatalog({
  libraries: [
    { id: 'dialogs', name: 'Диалоги', description: { en: 'Dialogs', ru: 'Диалоги' }, version: '1.2.0', file: 'd.qsps', sha256: SHA_2 },
    { id: 'ui', description: 'Menus', version: '0.1', file: 'ui.qsps', sha256: SHA_1, requires: ['dialogs'] },
  ],
}, URL_A);

const installed = (entries: Record<string, { version: string; sha256: string }>) =>
  installedLibraries({ installed: Object.fromEntries(Object.entries(entries).map(([id, e]) => [id, { ...e, catalog: URL_A }])) });

const section = (nodes: ReturnType<typeof buildLibraryTree>, name: 'installed' | 'available') =>
  nodes.find((n): n is SectionNode => n.kind === 'section' && n.section === name);

describe('buildLibraryTree', () => {
  it('shows installed libraries with updates, and the rest as available', () => {
    const [dialogs] = installed({ dialogs: { version: '1.0.0', sha256: SHA_1 } });
    const nodes = buildLibraryTree({
      installed: [{ lib: dialogs, fileHash: SHA_1 }], catalog, sourcesConfigured: true, language: 'ru',
    });
    expect(section(nodes, 'installed')!.children).toEqual([expect.objectContaining({
      kind: 'installed', id: 'dialogs', name: 'Диалоги', version: '1.0.0', description: 'Диалоги',
      updateTo: '1.2.0', edited: false, missing: false, inCatalog: true, sourcePath: 'libs/dialogs.qsps',
    })]);
    expect(section(nodes, 'available')!.children).toEqual([
      { kind: 'available', id: 'ui', name: 'ui', version: '0.1', description: 'Menus', requires: ['dialogs'] },
    ]);
    expect(nodes.filter(n => n.kind === 'message')).toEqual([]);
  });

  it('marks a library edited by hand, one gone from disk, and one no catalog lists', () => {
    const libs = installed({
      dialogs: { version: '1.2.0', sha256: SHA_1 },
      ui: { version: '0.1', sha256: SHA_1 },
      old: { version: '3.0', sha256: SHA_1 },
    });
    const nodes = buildLibraryTree({
      installed: [{ lib: libs[0], fileHash: SHA_2 }, { lib: libs[1], fileHash: undefined }, { lib: libs[2], fileHash: SHA_1 }],
      catalog, sourcesConfigured: true, language: 'en',
    });
    const [dialogs, ui, old] = section(nodes, 'installed')!.children as InstalledNode[];
    expect(dialogs).toMatchObject({ edited: true, missing: false });
    expect(dialogs.updateTo).toBeUndefined();
    expect(ui).toMatchObject({ missing: true, edited: false });
    expect(old).toMatchObject({ inCatalog: false, name: 'old', usage: "inclib 'libs/old.qsp'" });
    expect(section(nodes, 'available')).toBeUndefined();
  });

  it('explains an empty view', () => {
    expect(buildLibraryTree({ installed: [], catalog: undefined, sourcesConfigured: false, language: 'en' }))
      .toEqual([expect.objectContaining({ kind: 'message', action: 'openSettings' })]);
    expect(buildLibraryTree({
      installed: [], catalog: undefined, catalogError: 'Could not load https://x: offline', sourcesConfigured: true, language: 'en',
    })).toEqual([{ kind: 'message', severity: 'error', text: 'Could not load https://x: offline', action: 'refresh' }]);
    expect(buildLibraryTree({ installed: [], catalog: { libraries: [], problems: ['bad entry'] }, sourcesConfigured: true, language: 'en' }))
      .toEqual([{ kind: 'message', severity: 'warning', text: 'bad entry' }]);
  });
});
