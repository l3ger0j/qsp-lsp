// ── "QSP Libraries" view model ───────────────────────────────────────
//
// What the Libraries view shows: the game's installed libraries with their
// state, then what the catalogs offer besides, then why anything is
// missing. Pure; src/client/librariesView.ts turns it into tree items.

import { compareVersions, localizedDescription, type ParsedCatalog } from './libraryCatalog';
import type { LibraryFiles } from './libraryConfig';

/** An installed library and what is on disk now. */
export interface InstalledState {
  lib: LibraryFiles;
  /** SHA-256 of the file now; undefined when the file is gone. */
  fileHash: string | undefined;
}

export interface InstalledNode {
  kind: 'installed';
  id: string;
  name: string;
  version: string;
  description: string;
  usage: string;
  sourcePath: string;
  /** The file is gone: the build will stop until it is installed again or removed. */
  missing: boolean;
  /** The file differs from what was installed: an update would replace the author's changes. */
  edited: boolean;
  /** A newer version in the catalog. */
  updateTo?: string;
  /** The catalog no longer lists it (or wasn't loaded): it can't be updated. */
  inCatalog: boolean;
}

export interface AvailableNode {
  kind: 'available';
  id: string;
  name: string;
  version: string;
  description: string;
  requires: string[];
}

export interface MessageNode {
  kind: 'message';
  text: string;
  severity: 'info' | 'warning' | 'error';
  /** What clicking it does. */
  action?: 'openSettings' | 'refresh';
}

export interface SectionNode {
  kind: 'section';
  section: 'installed' | 'available';
  label: string;
  children: LibraryTreeNode[];
}

export type LibraryTreeNode = SectionNode | InstalledNode | AvailableNode | MessageNode;

/** What the view is built from. */
export interface LibraryTreeInput {
  installed: readonly InstalledState[];
  /** Undefined while no catalog has been loaded. */
  catalog: ParsedCatalog | undefined;
  /** Why the catalogs could not be loaded at all (no network, …). */
  catalogError?: string;
  sourcesConfigured: boolean;
  /** Editor language, for descriptions. */
  language: string;
}

/** The view's top-level nodes. */
export function buildLibraryTree(input: LibraryTreeInput): LibraryTreeNode[] {
  const { installed, catalog, language } = input;
  const offered = new Map((catalog?.libraries ?? []).map(l => [l.id.toLowerCase(), l]));
  const installedIds = new Set(installed.map(s => s.lib.id.toLowerCase()));
  const roots: LibraryTreeNode[] = [];

  if (installed.length > 0) {
    roots.push({
      kind: 'section',
      section: 'installed',
      label: 'Installed',
      children: installed.map((state): InstalledNode => {
        const { lib } = state;
        const latest = offered.get(lib.id.toLowerCase());
        return {
          kind: 'installed',
          id: lib.id,
          name: latest?.name ?? lib.id,
          version: lib.version,
          description: latest ? localizedDescription(latest.description, language) : '',
          usage: latest?.usage ?? `inclib '${lib.outputPath}'`,
          sourcePath: lib.sourcePath,
          missing: state.fileHash === undefined,
          edited: state.fileHash !== undefined && lib.sha256 !== '' && state.fileHash !== lib.sha256.toLowerCase(),
          ...(latest && compareVersions(latest.version, lib.version) > 0 ? { updateTo: latest.version } : {}),
          inCatalog: latest !== undefined,
        };
      }),
    });
  }

  const available: AvailableNode[] = (catalog?.libraries ?? [])
    .filter(l => !installedIds.has(l.id.toLowerCase()))
    .map(l => ({
      kind: 'available',
      id: l.id,
      name: l.name,
      version: l.version,
      description: localizedDescription(l.description, language),
      requires: l.requires,
    }));
  if (available.length > 0) {
    roots.push({ kind: 'section', section: 'available', label: 'Available', children: available });
  }

  if (!input.sourcesConfigured) {
    roots.push({
      kind: 'message',
      severity: 'info',
      text: 'No library catalogs yet: add a libraries.json URL to the qsp.libraries.sources setting',
      action: 'openSettings',
    });
  } else if (input.catalogError) {
    roots.push({ kind: 'message', severity: 'error', text: input.catalogError, action: 'refresh' });
  } else if (catalog && catalog.libraries.length === 0 && catalog.problems.length === 0) {
    roots.push({ kind: 'message', severity: 'info', text: 'The catalogs list no libraries' });
  }
  for (const problem of catalog?.problems ?? []) {
    roots.push({ kind: 'message', severity: 'warning', text: problem });
  }
  return roots;
}
