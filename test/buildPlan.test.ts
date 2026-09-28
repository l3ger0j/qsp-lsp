import { describe, it, expect } from 'vitest';
import {
  resolveBuildMode, perFileOutputPath, findOutputCollisions, orderForEntryPoint,
  resolveMainFileStrategy, resolveMainFilePattern, findMainFile, exactPathPattern, moveToFront,
} from '../src/common/buildPlan';

describe('resolveBuildMode', () => {
  it('prefers txt2gam.json over the VS Code setting', () => {
    expect(resolveBuildMode('single', 'perFile')).toBe('single');
    expect(resolveBuildMode('perFile', 'single')).toBe('perFile');
  });

  it('falls back to the setting when txt2gam.json has no buildMode', () => {
    expect(resolveBuildMode(undefined, 'perFile')).toBe('perFile');
  });

  it('defaults to single', () => {
    expect(resolveBuildMode(undefined, undefined)).toBe('single');
  });

  it('skips unknown values instead of trusting them', () => {
    expect(resolveBuildMode('perfile', 'perFile')).toBe('perFile');
    expect(resolveBuildMode(true, 'bogus')).toBe('single');
  });
});

describe('perFileOutputPath', () => {
  it('replaces .qsps and .qsrc with .qsp in the same folder', () => {
    expect(perFileOutputPath('/game/data.qsps')).toBe('/game/data.qsp');
    expect(perFileOutputPath('/game/lib/main.qsrc')).toBe('/game/lib/main.qsp');
  });

  it('matches the extension case-insensitively', () => {
    expect(perFileOutputPath('/game/DATA.QSPS')).toBe('/game/DATA.qsp');
  });

  it('keeps Cyrillic and spaces in the name', () => {
    expect(perFileOutputPath('/игра/мои локации.qsps')).toBe('/игра/мои локации.qsp');
  });

  it('only touches the final extension', () => {
    expect(perFileOutputPath('/game/a.qsps.bak.qsps')).toBe('/game/a.qsps.bak.qsp');
  });
});

describe('findOutputCollisions', () => {
  it('reports two sources that build into the same .qsp', () => {
    expect(findOutputCollisions(['/g/a.qsps', '/g/a.qsrc', '/g/b.qsps'])).toEqual([
      { output: '/g/a.qsp', sources: ['/g/a.qsps', '/g/a.qsrc'] },
    ]);
  });

  it('treats names differing only in case as colliding', () => {
    expect(findOutputCollisions(['/g/A.qsps', '/g/a.qsrc'])).toHaveLength(1);
  });

  it('does not flag the same name in different folders', () => {
    expect(findOutputCollisions(['/g/x/data.qsps', '/g/y/data.qsps'])).toEqual([]);
  });
});

describe('orderForEntryPoint', () => {
  const files = ['data/data.qsps', 'lib/util.qsps', 'main.qsps', 'z.qsps'];

  it('puts the picked entry file first and keeps the rest in order', () => {
    expect(orderForEntryPoint(files, 'z.qsps')).toEqual(['z.qsps', 'data/data.qsps', 'lib/util.qsps', 'main.qsps']);
  });

  it('without a pick, puts root files before files in subfolders', () => {
    expect(orderForEntryPoint(files)).toEqual(['main.qsps', 'z.qsps', 'data/data.qsps', 'lib/util.qsps']);
  });

  it('ignores a pick that is not in the list', () => {
    expect(orderForEntryPoint(files, 'missing.qsps')).toEqual(orderForEntryPoint(files));
  });
});

describe('resolveMainFileStrategy', () => {
  it('is ask unless the setting says root', () => {
    expect(resolveMainFileStrategy('root')).toBe('root');
    expect(resolveMainFileStrategy('ask')).toBe('ask');
    expect(resolveMainFileStrategy(undefined)).toBe('ask');
    expect(resolveMainFileStrategy('bogus')).toBe('ask');
  });
});

describe('resolveMainFilePattern', () => {
  it('prefers txt2gam.json over the setting', () => {
    expect(resolveMainFilePattern('main', 'other')).toBe('main');
  });

  it('skips blank and non-string values', () => {
    expect(resolveMainFilePattern('  ', 'other')).toBe('other');
    expect(resolveMainFilePattern(42, '')).toBeUndefined();
  });
});

describe('findMainFile', () => {
  const files = ['data/data.qsps', 'lib/Main.qsps', 'main.qsps'];

  it('searches the pattern in each path case-insensitively and takes the first match in order', () => {
    expect(findMainFile(files, 'main\\.qsps$')).toEqual({ index: 1, matchCount: 2 });
  });

  it('can be made unambiguous with anchors', () => {
    expect(findMainFile(files, '^main\\.qsps$')).toEqual({ index: 2, matchCount: 1 });
  });

  it('matches Cyrillic paths', () => {
    expect(findMainFile(['модули/данные.qsps', 'игра.qsps'], '^игра')).toEqual({ index: 1, matchCount: 1 });
  });

  it('throws when nothing matches', () => {
    expect(() => findMainFile(files, 'start\\.qsps')).toThrow(/matches none/);
  });

  it('throws on an invalid regular expression', () => {
    expect(() => findMainFile(files, 'main(')).toThrow(/not a valid regular expression/);
  });
});

describe('exactPathPattern', () => {
  it('matches only the given path, escaping regex characters', () => {
    const p = exactPathPattern('dir (1)/main.v2.qsps');
    expect(new RegExp(p, 'i').test('dir (1)/main.v2.qsps')).toBe(true);
    expect(new RegExp(p, 'i').test('dir (1)/mainXv2.qsps')).toBe(false);
    expect(new RegExp(p, 'i').test('x/dir (1)/main.v2.qsps')).toBe(false);
  });
});

describe('moveToFront', () => {
  it('moves one element to the front and keeps the rest in order', () => {
    expect(moveToFront(['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'a', 'b', 'd']);
    expect(moveToFront(['a', 'b'], 0)).toEqual(['a', 'b']);
  });
});
