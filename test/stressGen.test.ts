/**
 * The stress-test game generator (scripts/stress/genGame.mjs).
 *
 * Why
 * ───
 * - Load tests are only meaningful on code the parser accepts: a
 *   generator that wrote syntax errors would measure error recovery.
 * - A crash report's shape (file count, location sizes) is how a game
 *   that can't be shared gets reproduced, so it must steer the output.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { buildLocationIndex } from '../src/parser';
// @ts-expect-error: a plain .mjs script without type declarations
import { generateGame, optionsFromShape } from '../scripts/stress/genGame.mjs';
import { initParser } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

describe('stress game generator', () => {
  for (const profile of ['mixed', 'text', 'code']) {
    it(`writes valid QSP (${profile})`, () => {
      const game = generateGame({ locations: 30, chars: 3000, files: 2, profile, seed: 7 });
      expect(game.files).toHaveLength(2);
      const text = game.files.map((f: { text: string }) => f.text).join('');
      expect(buildLocationIndex(text)).toHaveLength(30);
      const tree = parser.parseOnce(text)!;
      try {
        expect(tree.rootNode.hasError).toBe(false);
      } finally {
        tree.delete();
      }
    });
  }

  it('is repeatable for a seed', () => {
    const a = generateGame({ locations: 5, chars: 2000, seed: 3 }).files[0].text;
    expect(generateGame({ locations: 5, chars: 2000, seed: 3 }).files[0].text).toBe(a);
  });

  it('repeats location sizes one by one from a report\'s location table', () => {
    const sizes = [800, 30_000, 1200];
    const opts = optionsFromShape({ report: { locationTable: sizes.map((chars, i) => ({ id: `f01_l000${i + 1}`, chars, lines: 1 })) } });
    const text = generateGame({ ...opts, seed: 2 }).files.map((f: { text: string }) => f.text).join('');
    const got = buildLocationIndex(text).map(l => l.endOffset - l.startOffset);
    expect(got).toHaveLength(3);
    got.forEach((n, i) => {
      expect(n).toBeGreaterThanOrEqual(sizes[i]);
      expect(n).toBeLessThan(sizes[i] + 2000);
    });
  });

  it('follows the shape of a performance report', () => {
    const report = {
      files: [{}, {}, {}],
      locations: { chars: { count: 40, min: 500, median: 1000, p90: 4000, p99: 9000, max: 20000 } },
      globalBindings: { variables: 50 },
    };
    const opts = optionsFromShape(report);
    expect(opts).toMatchObject({ locations: 40, files: 3, variables: 50 });
    const text = generateGame({ ...opts, seed: 1 }).files.map((f: { text: string }) => f.text).join('');
    const locs = buildLocationIndex(text);
    expect(locs).toHaveLength(40);
    expect(Math.max(...locs.map(l => l.endOffset - l.startOffset))).toBeLessThan(21000);
  });
});
