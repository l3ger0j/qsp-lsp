import { describe, it, expect } from 'vitest';
import { joinSources, normalizeText, orderSourceFiles, type SourceFile } from '../src/common/projectFiles';

const file = (relPath: string): SourceFile => ({ relPath, sortKey: `file:///w/${encodeURI(relPath)}` });
// A stand-in for a real glob matcher: `dir/*` or an exact path.
const matches = (pattern: string, relPath: string) =>
  pattern.endsWith('/*') ? relPath.startsWith(pattern.slice(0, -1)) && !relPath.slice(pattern.length - 1).includes('/') : pattern === relPath;

describe('normalizeText', () => {
  it('strips a BOM and turns CRLF and CR into LF', () => {
    expect(normalizeText('﻿a\r\nb\rc')).toBe('a\nb\nc');
  });
});

describe('joinSources', () => {
  it('ends every file with a newline and puts a blank line between files', () => {
    expect(joinSources(['# a\n---', '﻿# b\r\n---\r\n'])).toBe('# a\n---\n\n# b\n---\n');
  });
});

describe('orderSourceFiles', () => {
  const files = ['main.qsps', 'data/b.qsps', 'data/a.qsps', 'extra.qsps'].map(file);

  it('sorts all files when there are no patterns', () => {
    expect(orderSourceFiles(files, undefined, matches).map(f => f.relPath))
      .toEqual(['data/a.qsps', 'data/b.qsps', 'extra.qsps', 'main.qsps']);
    expect(orderSourceFiles(files, [], matches)).toHaveLength(4);
  });

  it('follows the pattern order, sorts within a pattern and leaves unmatched files out', () => {
    expect(orderSourceFiles(files, ['main.qsps', 'data/*'], matches).map(f => f.relPath))
      .toEqual(['main.qsps', 'data/a.qsps', 'data/b.qsps']);
  });

  it('does not repeat a file matched by an earlier pattern', () => {
    expect(orderSourceFiles(files, ['data/b.qsps', 'data/*'], matches).map(f => f.relPath))
      .toEqual(['data/b.qsps', 'data/a.qsps']);
  });

  it('orders by the sort key, so Cyrillic names sort like their URIs', () => {
    const cyr = ['игра.qsps', 'а.qsps'].map(file);
    const expected = [...cyr].sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map(f => f.relPath);
    expect(orderSourceFiles(cyr, undefined, matches).map(f => f.relPath)).toEqual(expected);
  });
});
