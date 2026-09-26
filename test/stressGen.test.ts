/**
 * The stress-test game generator (scripts/stress/genGame.mjs).
 *
 * Why
 * ───
 * - Load tests are only meaningful on code the parser accepts: a
 *   generator that wrote syntax errors would measure error recovery.
 * - A performance report's shape (location sizes, construct counts) is
 *   how a game that can't be shared gets reproduced, so it must steer
 *   the output.
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

  it('follows the shape of a performance report', () => {
    const report = {
      environment: {},
      report: {
        files: [{}, {}, {}],
        locations: { chars: { count: 40, min: 500, median: 1000, p90: 4000, p99: 9000, max: 20000 } },
        globalBindings: { variables: 50 },
        nodeTypes: { maxDepth: 20, types: { if_block: { count: 900, chars: 0, maxChars: 0 }, statement: { count: 100, chars: 0, maxChars: 0 }, single_quoted_string: { count: 10, chars: 1000, maxChars: 200 } } },
      },
    };
    const opts = optionsFromShape(report);
    expect(opts).toMatchObject({ locations: 40, files: 3, stringChars: 100, variables: 50 });
    expect(opts.weights).toEqual({ if_block: 900, statement: 100 });
    const game = generateGame({ ...opts, seed: 1 });
    const text = game.files.map((f: { text: string }) => f.text).join('');
    const locs = buildLocationIndex(text);
    expect(locs).toHaveLength(40);
    expect(Math.max(...locs.map(l => l.endOffset - l.startOffset))).toBeLessThan(21000);
    // The report is mostly if blocks; the same sizes with the default mix have far fewer.
    const plain = generateGame({ ...opts, weights: undefined, seed: 1 }).files.map((f: { text: string }) => f.text).join('');
    const ifs = (t: string) => (t.match(/^\s*if .*:$/gm) ?? []).length / t.length;
    expect(ifs(text)).toBeGreaterThan(2 * ifs(plain));
  });
});
