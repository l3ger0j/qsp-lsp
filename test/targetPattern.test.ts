/**
 * Target patterns: what can be said about a jump target or an assigned
 * string without running the game.
 *
 * Why
 * ───
 * - The jump graph turns `gt $next` and `gt 'room_' + n` into possible
 *   edges from the values the variables are known to take; that needs
 *   the literal pieces, the variables, and the unknown pieces of an
 *   expression, in order.
 * - Interpolated strings, `iif` and doubled quotes are how QSP games
 *   commonly build location names.
 * - Anything else (a function call, arithmetic) must not pretend to be
 *   known.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { getFirstArgNode } from '../src/parser/walkHelpers';
import { targetPatternOf, literalOf } from '../src/parser/targetPattern';
import { initParser } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

// The pattern of the target of the first statement of a one-line location.
function patternOfJump(stmt: string) {
  const tree = parser.parseOnce(`# a\n${stmt}\n---\n`)!;
  let found: ReturnType<typeof targetPatternOf> | 'none' = 'none';
  const walk = (n: import('web-tree-sitter').SyntaxNode) => {
    if (found !== 'none') return;
    if (n.type === 'statement' || n.type === 'na_func_call' || n.type === 'ml_func_call') {
      const name = n.childForFieldName('name')?.text.toLowerCase();
      if (name && ['gt', 'goto', 'gs', 'gosub', 'xgt', 'func'].includes(name)) {
        found = targetPatternOf(getFirstArgNode(n)!);
        return;
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i)!);
  };
  walk(tree.rootNode);
  tree.delete();
  return found;
}

describe('targetPatternOf', () => {
  it('splits literals and variables', () => {
    expect(patternOfJump('gt $next')).toEqual([{ var: 'next' }]);
    expect(patternOfJump("gt 'room_' + n")).toEqual([{ lit: 'room_' }, { var: 'n' }]);
    expect(patternOfJump("gt 'a' + 'b' + $C")).toEqual([{ lit: 'ab' }, { var: 'c' }]);
    expect(patternOfJump("gt ($Куда)")).toEqual([{ var: 'куда' }]);
    expect(patternOfJump('gt $rooms[2]')).toEqual([{ var: 'rooms', index: 2 }]);
    expect(patternOfJump('gt $rooms[i]')).toEqual([{ var: 'rooms' }]);
  });

  it('reads interpolated strings and doubled quotes', () => {
    expect(patternOfJump('gt "room_<<n>>_x"')).toEqual([{ lit: 'room_' }, { var: 'n' }, { lit: '_x' }]);
    expect(patternOfJump("gt 'it''s <<$a>>'")).toEqual([{ lit: "it's " }, { var: 'a' }]);
  });

  it('keeps both branches of iif', () => {
    expect(patternOfJump("gs iif(x, 'a', $b)")).toEqual([{ alt: [[{ lit: 'a' }], [{ var: 'b' }]] }]);
  });

  it('marks what it cannot know, and gives up when nothing is known', () => {
    expect(patternOfJump("gt 'room_' + $mid($s, 1, 2)")).toEqual([{ lit: 'room_' }, { any: true, why: 'call:mid' }]);
    expect(patternOfJump('gt $mid($s, 1, 2)')).toBeUndefined();
    expect(patternOfJump("gt 'room_' + n * 2")).toEqual([{ lit: 'room_' }, { any: true, why: 'op_arith *' }]);
  });

  it('passes $str and friends through, and reads a function call as the callee\'s result', () => {
    expect(patternOfJump("gt 'loc_' + $str(n)")).toEqual([{ lit: 'loc_' }, { var: 'n' }]);
    expect(patternOfJump('gt $lcase($trim($next))')).toEqual([{ var: 'next' }]);
    expect(patternOfJump("gt func('Pick')")).toEqual([{ result: 'pick' }]);
    expect(patternOfJump("gt $func('pick', 1)")).toEqual([{ result: 'pick' }]);
    expect(patternOfJump('gt @pick(1)')).toEqual([{ result: 'pick' }]);
    expect(patternOfJump('gt $args[1]')).toEqual([{ var: 'args', index: 1 }]);
  });

  it('reads <<…>> bodies with doubled quotes, as older games write them', () => {
    expect(patternOfJump("gt 'x<<''room_'' + $n>>'")).toEqual([{ lit: 'xroom_' }, { var: 'n' }]);
    expect(patternOfJump("gt '<<$str(k) & ''_b''>>'")).toEqual([{ var: 'k' }, { lit: '_b' }]);
    expect(patternOfJump("gt '<<''r'' + $rooms[3]>>'")).toEqual([{ lit: 'r' }, { var: 'rooms', index: 3 }]);
    expect(patternOfJump("gt 'r<<''a'' + n * 2>>'")).toEqual([{ lit: 'r' }, { any: true, why: 'interpolation_raw_body' }]);
    expect(patternOfJump("gt '<<$mid(''abc'', 1, 1)>>'")).toBeUndefined();
  });

  it('tells a single literal apart', () => {
    expect(literalOf([{ lit: 'x' }])).toBe('x');
    expect(literalOf([{ lit: 'x' }, { var: 'n' }])).toBeUndefined();
  });
});
