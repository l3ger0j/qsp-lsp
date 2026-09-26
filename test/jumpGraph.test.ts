/**
 * The jump graph (`qsp/jumpGraph`): who jumps to or calls whom.
 *
 * Why
 * ───
 * - Every kind of jump and call is an edge of its own type, with the
 *   first few places it is written and a count; several `gt 'b'` in one
 *   location are one edge. A big game has tens of thousands of jump
 *   sites, and listing them all made replies tens of megabytes.
 * - A target no file defines still shows, as a missing node.
 * - `loc 'name'` only checks that a location exists: not an edge.
 * - A target that isn't a string literal (`gt $next`, `gt 'room_' + $n`,
 *   an interpolated string) has no name to be a location ref under; it is
 *   kept separately so the graph can show a jump to an unknown target,
 *   including from `exec:` links and from files parsed per location.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { buildLocationIndex, DocumentSymbols, extractSymbols } from '../src/parser';
import { buildJumpGraph, type JumpGraphSource } from '../src/server/jumpGraph';
import { initParser, parseAndExtract } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

function source(code: string, uri = 'file:///game/main.qsps'): JumpGraphSource {
  const { symbols } = parseAndExtract(parser, code, uri);
  return { uri, symbols, locationIndex: buildLocationIndex(code) };
}

const edgeList = (code: string) =>
  buildJumpGraph([source(code)]).edges.map(e => `${e.from}->${e.to}:${e.callType}(${e.siteCount})`).sort();

describe('buildJumpGraph: exact edges', () => {
  it('types each jump and call', () => {
    const code = [
      '# a',
      "gt 'b'",
      "xgt 'b'",
      "gosub 'c'",
      "x = func('d')",
      '@e',
      "$t = desc('b')",
      '---',
      '# b', '---', '# c', '---', '# d', '---', '# e', '---',
    ].join('\n') + '\n';
    expect(edgeList(code)).toEqual([
      'a->b:desc(1)', 'a->b:goto(2)', 'a->c:gosub(1)', 'a->d:func(1)', 'a->e:func(1)',
    ]);
  });

  it('lists the sites of an edge, with their line and text (the file is the location\'s own)', () => {
    const graph = buildJumpGraph([source("# a\ngt 'B'\nif x: gt 'b'\n---\n# B\n---\n")]);
    expect(graph.edges).toEqual([{
      from: 'a', to: 'b', callType: 'goto', kind: 'exact', siteCount: 2,
      sites: [
        { line: 1, text: "gt 'B'" },
        { line: 2, text: "gt 'b'" },
      ],
    }]);
  });

  it('keeps only the earliest three sites, counts them all, and shortens long ones', () => {
    const long = `gt 'b', '${'x'.repeat(200)}'`;
    const graph = buildJumpGraph([
      source(`# a\n${long}\ngt 'b'\ngt 'b'\ngt 'b'\n---\n# b\n---\n`, 'file:///game/z.qsps'),
      source("# c\n---\n# a2\n---\n", 'file:///game/a.qsps'),
    ]);
    const [edge] = graph.edges;
    expect(edge.siteCount).toBe(4);
    expect(edge.sites.map(x => x.line)).toEqual([1, 2, 3]);
    expect(edge.sites[0].text).toHaveLength(120);
    expect(edge.sites[0].text.endsWith('…')).toBe(true);
  });

  it('shows a target nobody defines as a missing node', () => {
    const graph = buildJumpGraph([source("# a\ngt 'nowhere'\n---\n")]);
    expect(graph.nodes).toEqual(expect.arrayContaining([{ name: 'nowhere', missing: true }]));
  });

  it('does not count `loc` (an existence check) as a jump', () => {
    expect(edgeList("# a\nif loc('b'): *pl 1\n---\n# b\n---\n")).toEqual([]);
  });

  it('names the file of a site in another file than the location\'s first definition', () => {
    const graph = buildJumpGraph([
      source("# a\n---\n# b\n---\n", 'file:///game/main.qsps'),
      source("# a\ngt 'b'\n---\n", 'file:///game/copy.qsps'),
    ]);
    expect(graph.edges[0].sites).toEqual([{ uri: 'file:///game/copy.qsps', line: 1, text: "gt 'b'" }]);
  });

  it('connects locations across files, Cyrillic names included', () => {
    const graph = buildJumpGraph([
      source("# старт\ngt 'Лес'\n---\n", 'file:///game/main.qsps'),
      source('# лес\n---\n', 'file:///game/forest.qsps'),
    ]);
    expect(graph.edges.map(e => `${e.from}->${e.to}`)).toEqual(['старт->лес']);
    expect(graph.nodes).toEqual(expect.arrayContaining([{ name: 'лес', uri: 'file:///game/forest.qsps', line: 0 }]));
  });
});

describe('buildJumpGraph: targets that are not literals', () => {
  it('lists them as unresolved per call type, with the target expressions', () => {
    const code = "# a\ngt $next\ngosub 'room_' + $n\nx = func($f)\ngt '<<$where>>'\ngt $next\n---\n";
    const graph = buildJumpGraph([source(code)]);
    expect(graph.edges).toEqual([]);
    expect(graph.unresolved.map(u => [u.callType, u.exprs, u.sites.map(x => x.line), u.siteCount])).toEqual([
      ['goto', ['$next', "'<<$where>>'"], [1, 4, 5], 3],
      ['gosub', ["'room_' + $n"], [2], 1],
      ['func', ['$f'], [3], 1],
    ]);
    expect(graph.unresolved[1].sites[0].text).toBe("gosub 'room_' + $n");
  });

  it('keeps them from exec: links', () => {
    const code = `# a\n*pl '<a href="exec:gt $next">go</a>'\n---\n`;
    const uri = 'file:///game/main.qsps';
    const tree = parser.parse(uri, code)!;
    // exec: bodies are analyzed only with a re-parse callback, as the server passes.
    const { symbols } = extractSymbols(tree, uri, undefined, undefined, (t) => parser.parseOnce(t));
    const graph = buildJumpGraph([{ uri, symbols, locationIndex: buildLocationIndex(code) }]);
    expect(graph.unresolved.map(u => u.exprs)).toEqual([['$next']]);
    expect(graph.unresolved[0].sites[0].line).toBe(1);
  });

  it('keeps their lines when a location is merged in from a per-location parse', () => {
    // How large files are analyzed: each location parsed alone, then shifted into the file.
    const locText = '# far\n*pl 1\ngt $next\n---\n';
    const tree = parser.parseOnce(locText)!;
    const { symbols: alone } = extractSymbols(tree, 'file:///game/big.qsps');
    tree.delete();
    const file = new DocumentSymbols('file:///game/big.qsps');
    const [locSyms] = alone.locations.values();
    file.addLocationFrom('far', { uri: 'file:///game/big.qsps', line: 100, column: 2, endLine: 100, endColumn: 5 }, locSyms, 100);
    expect(file.getLocation('far')!.dynamicLocationRefs[0].loc.line).toBe(102);
  });
});
