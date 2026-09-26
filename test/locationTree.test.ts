import { describe, it, expect } from 'vitest';
import {
  buildLocationTree,
  countDiagnostics,
  findLocationNode,
  parentIndex,
  type FileNode,
  type FolderNode,
  type LocationItem,
  type LocationNode,
} from '../src/common/locationTree';

const U = (p: string) => `file:///game/${p}`;
const relPath = (uri: string) => uri.replace('file:///game/', '');

// As the server lists them: sorted by name, not by file or line.
const items: LocationItem[] = [
  { name: 'Алиса', uri: U('data/people.qsps'), line: 0, endLine: 3 },
  { name: 'end', uri: U('main.qsps'), line: 10, endLine: 12 },
  { name: 'Start', uri: U('main.qsps'), line: 0, endLine: 9 },
  { name: 'utils', uri: U('lib/deep/utils.qsps'), line: 0, endLine: 2 },
  { name: 'Боб', uri: U('data/people.qsps'), line: 4, endLine: 6 },
];

describe('buildLocationTree: by file', () => {
  const roots = buildLocationTree(items, { grouping: 'file', relPath, startFileUri: U('main.qsps') });

  it('nests files in their folders, folders first, each alphabetically', () => {
    expect(roots.map(n => (n.kind === 'location' ? n.name : n.label))).toEqual(['data', 'lib', 'main.qsps']);
    const lib = roots[1] as FolderNode;
    const deep = lib.children[0] as FolderNode;
    expect(deep).toMatchObject({ kind: 'folder', label: 'deep', relPath: 'lib/deep' });
    expect((deep.children[0] as FileNode).label).toBe('utils.qsps');
  });

  it('keeps source order inside a file', () => {
    const main = roots[2] as FileNode;
    expect(main.children.map(l => l.name)).toEqual(['Start', 'end']);
    const people = (roots[0] as FolderNode).children[0] as FileNode;
    expect(people.children.map(l => l.name)).toEqual(['Алиса', 'Боб']);
  });

  it('marks only the main file\'s first location as the start', () => {
    const all: LocationNode[] = [];
    const visit = (n: FolderNode | FileNode | LocationNode) => (n.kind === 'location' ? all.push(n) : n.children.forEach(visit));
    roots.forEach(visit);
    expect(all.filter(n => n.isStart).map(n => n.name)).toEqual(['Start']);
  });

  it('knows every node\'s parent and finds the location around a line', () => {
    const parents = parentIndex(roots);
    const loc = findLocationNode(roots, U('main.qsps'), 11)!;
    expect(loc.name).toBe('end');
    expect(parents.get(loc.id)).toMatchObject({ kind: 'file', label: 'main.qsps' });
    expect(parents.get(roots[0].id)).toBeUndefined();
    expect(findLocationNode(roots, U('main.qsps'), 50)).toBeUndefined();
  });
});

describe('buildLocationTree: flat', () => {
  it('lists every location alphabetically, ignoring case, with its file', () => {
    const roots = buildLocationTree(items, { grouping: 'flat', relPath });
    expect(roots.map(n => (n as LocationNode).name)).toEqual(['end', 'Start', 'utils', 'Алиса', 'Боб']);
    expect((roots[0] as LocationNode).relPath).toBe('main.qsps');
  });

  it('keeps same-named locations apart, ordered by file', () => {
    const dupes = [
      { name: 'x', uri: U('b.qsps'), line: 0, endLine: 1 },
      { name: 'X', uri: U('a.qsps'), line: 5, endLine: 6 },
    ];
    const roots = buildLocationTree(dupes, { grouping: 'flat', relPath }) as LocationNode[];
    expect(roots.map(n => n.relPath)).toEqual(['a.qsps', 'b.qsps']);
    expect(new Set(roots.map(n => n.id)).size).toBe(2);
  });
});

describe('diagnostic counts', () => {
  it('counts errors and warnings on a location\'s lines only', () => {
    const marks = [
      { line: 1, severity: 'error' as const },
      { line: 2, severity: 'warning' as const },
      { line: 2, severity: 'other' as const },
      { line: 11, severity: 'error' as const },
    ];
    expect(countDiagnostics(marks, 0, 9)).toEqual({ errors: 1, warnings: 1 });

    const roots = buildLocationTree(items, { grouping: 'flat', relPath, diagnostics: uri => (uri === U('main.qsps') ? marks : []) });
    const byName = new Map((roots as LocationNode[]).map(n => [n.name, n]));
    expect(byName.get('Start')).toMatchObject({ errors: 1, warnings: 1 });
    expect(byName.get('end')).toMatchObject({ errors: 1, warnings: 0 });
    expect(byName.get('Алиса')).toMatchObject({ errors: 0, warnings: 0 });
  });
});
