import { describe, it, expect } from 'vitest';
import { resolveBuildMode, perFileOutputPath, findOutputCollisions } from '../src/common/buildPlan';

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
