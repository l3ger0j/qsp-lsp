/**
 * A file's interface: what the other project files can see of it.
 *
 * Why
 * ───
 * - After an edit, the project's other files are diagnosed again only when
 *   the edited file's interface changed (ProjectModeService.rebuildAndReanalyzeAll).
 *   If the interface misses anything their diagnostics read, they keep stale
 *   warnings: so every edit below checks the diagnostics the client was left
 *   with against those of the same files analysed from scratch.
 * - Edits that only move things (game text, comments, new lines) must keep
 *   the interface, or nothing is saved.
 * - While no location's interface changes, the propagation of locals is
 *   kept (reusePropagation), with the edited locations' symbols swapped in:
 *   the aggregates must equal those built from scratch, positions and all
 *   (hover and navigation read them), in a project and in a single file.
 * - The hash is made once per location and kept with it; an analysis read
 *   back from the cache must hash the same.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as v8 from 'v8';
import type { Connection, Diagnostic, TextDocuments } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { LocationSymbols, locationInterfaceHash, type DocumentSymbols } from '../src/parser';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { ProjectModeService } from '../src/server/projectMode';
import { buildFileAggregates, collectCallTypesPerTarget, fileAggregates, type PropagationBase, type SymbolAggregates } from '../src/server/aggregation';
import { extractLocationSymbols } from '../src/server/locationAnalysis';
import { compactDeserialized } from '../src/server/nodeCache';
import type { DocumentState } from '../src/server/featureTypes';
import type { DiagnosticSettings } from '../src/server/diagnostics';
import { PerfLog } from '../src/server/perfLog';
import { ALL_DIAGS_OFF, initParser } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

const ALL_DIAGS_ON = Object.fromEntries(
  Object.entries(ALL_DIAGS_OFF).map(([k, v]) => [k, typeof v === 'boolean' ? true : v]),
) as unknown as DiagnosticSettings;

// The file edited below, and two that see it: globals, objects and actions
// across files, calls that pass locals, a code block run elsewhere, `args`
// and `result`, a location defined twice.
const MAIN = `# старт
! начало игры
$мир = 'Северный край'
счёт = 0
$код = { счёт += args[0] & result = счёт }
addobj 'Фонарь'
local шаг = 1
gs 'помощь', шаг
x = @считать(1, 2)
pl 'Добро пожаловать, <<$имя>>', $ответ
if счёт > 0:
  pl 'ещё не время'
  gt 'лес'
end
act 'Осмотреться':
  *pl 'Тишина.'
  dynamic $код, 2
  gs 'забытая', 1, 2
end
:метка
loop local i = 0 while i < 3 step i += 1:
  pl i, #сила
end
---
# общая
*pl 'то же имя, что в другом файле'
---
`;
const FOREST = `# лес
pl $мир, $погода
if obj 'Фонарь': delobj 'Фонарь'
gs 'помощь'
$ответ = 'да'
$сила = 'строка'
---
# помощь
pl шаг, args[0]
delact 'Осмотреться'
---
# считать
result = args[0] + args[1] + $код
---
# забытая
pl 'сюда никто не ходит'
---
`;
const OTHER = `# общая
pl 'и здесь'
---
# пустая
pl неизвестная
x = dyneval($код, 1)
---
`;

// Insert a letter, a space or a line break, or delete a character, at
// the start, middle and end of every line, plus edits that change one thing
// other locations may see. The test undoes each one, which is an edit too.
function editsOf(text: string): string[] {
  const lines = text.split('\n');
  const edits: string[] = [];
  let offset = 0;
  for (const line of lines) {
    for (const col of new Set([0, Math.floor(line.length / 2), line.length])) {
      const at = offset + col;
      for (const insert of ['x', ' ', '\n']) edits.push(text.slice(0, at) + insert + text.slice(at));
      if (col < line.length) edits.push(text.slice(0, at) + text.slice(at + 1));
    }
    offset += line.length + 1;
  }

  // Edits that change one thing other files may see.
  for (const [from, to] of [
    ["gs 'помощь', шаг", "gt 'помощь', шаг"],
    ["gs 'помощь', шаг", "gs 'помощь'"],
    ['x = @считать(1, 2)', "gs 'считать', 1, 2"],
    ['result = счёт', 'счёт = счёт'],
    ['#сила', '$сила'],
    ['local шаг = 1', 'шаг = 1'],
    ['local шаг = 1', 'local шаг'],
    ["$мир = 'Северный край'", "$мир = 'Южный край'"],
    ["$мир = 'Северный край'", "$мир += 'Южный край'"],
    ["$мир = 'Северный край'", 'killvar $мир'],
    ['$ответ', '$вопрос'],
    ["addobj 'Фонарь'", "delobj 'Фонарь'"],
    ["  gs 'забытая', 1, 2", "  gs 'забытая'"],
    ['  dynamic $код, 2', '  x = dyneval($код, 2)'],
    ["act 'Осмотреться':", "act 'Осмотреть':"],
    ["local шаг = 1\ngs 'помощь', шаг", "gs 'помощь', шаг\nlocal шаг = 1"],
  ]) {
    expect(text).toContain(from);
    edits.push(text.replace(from, to));
  }

  return edits;
}

function project() {
  const connection = {
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    sendDiagnostics: () => {},
  } as unknown as Connection;
  const documents = { get: () => undefined, all: () => [] } as unknown as TextDocuments<TextDocument>;
  const states = new Map<string, DocumentState>();
  const service = new ProjectModeService(connection, documents, states, parser);
  const callTypes = () => collectCallTypesPerTarget([...states.values()].map(s => s.symbols));
  const peers = (own: string): DocumentSymbols[] => [...states].filter(([u]) => u !== own).map(([, s]) => s.symbols);
  const add = (uri: string, text: string) => {
    service.projectFileUris.add(uri);
    service.analyzeFile(uri, text);
  };
  return {
    service,
    add,
    symbolsOf: (uri: string) => states.get(uri)!.symbols,
    /** Diagnose as the server does after `changed` changed; returns the files it diagnosed. */
    run(changed?: string): Map<string, Diagnostic[]> {
      const out = new Map<string, Diagnostic[]>();
      service.rebuildAndReanalyzeAll(ALL_DIAGS_ON, callTypes, peers, out, changed === undefined ? undefined : [changed]);
      return out;
    },
    /** Every file's diagnostics from the current aggregates. */
    truth(): Map<string, Diagnostic[]> {
      const out = new Map<string, Diagnostic[]>();
      service.reanalyzeAll(ALL_DIAGS_ON, callTypes, peers, () => undefined, out);
      return out;
    },
  };
}

const A = 'file:///game/main.qsps';
const B = 'file:///game/forest.qsps';
const C = 'file:///game/other.qsps';

describe('file interface', () => {
  it('leaves the other files the diagnostics a full re-diagnosis gives them, edit after edit', () => {
    const p = project();
    p.add(A, MAIN);
    p.add(B, FOREST);
    p.add(C, OTHER);
    const perfLines: string[] = [];
    p.service.perf = new PerfLog(line => perfLines.push(line));
    p.service.perf.verbose = true;
    const shown = p.run();
    expect(shown.get(B)!.length + shown.get(C)!.length).toBeGreaterThan(0);

    const edits = editsOf(MAIN);

    let partial = 0;
    let reused = 0;
    for (const text of edits.flatMap(e => [e, MAIN])) {
      p.add(A, text);
      const diagnosed = p.run(A);
      if (!diagnosed.has(B)) partial++;
      if (!/[·,] propagation \d/.test(perfLines.filter(l => l.includes('project aggregates')).at(-1)!)) reused++;
      for (const [uri, d] of diagnosed) shown.set(uri, d);
      // The same files analysed from scratch.
      const q = project();
      q.add(A, text);
      q.add(B, FOREST);
      q.add(C, OTHER);
      const truth = q.run();
      for (const uri of [A, B, C]) expect(shown.get(uri), `${uri} after editing to:\n${text}`).toEqual(truth.get(uri));
      expect(p.service.projectAggregates, `aggregates after editing to:\n${text}`).toEqual(q.service.projectAggregates);
    }
    // Both ways were taken: text edits kept the interface, others changed it.
    expect(reused).toBe(partial);
    expect(partial).toBeGreaterThan(edits.length / 2);
    expect(partial).toBeLessThan(edits.length * 2);
  });

  it('gives a single file the aggregates a fresh build does, reusing the propagation across edits', () => {
    const p = project();
    const rest = FOREST + OTHER;
    let before: { symbols: DocumentSymbols; propagation?: PropagationBase; aggCache?: SymbolAggregates } | undefined;
    let reused = 0;
    for (const text of editsOf(MAIN).flatMap(e => [e, MAIN])) {
      p.add(A, text + rest);
      const symbols = p.symbolsOf(A);
      // As the server does: a new state, with the propagation of the one before.
      const state = { symbols, propagation: before?.propagation };
      const agg = fileAggregates(state, A);
      if (before && agg.propagationCallers === before.aggCache!.propagationCallers) reused++;
      expect(agg, `after editing to:\n${text}`).toEqual(buildFileAggregates(symbols, A));
      before = { ...state, aggCache: agg };
    }
    expect(reused).toBeGreaterThan(100);
  });

  it('diagnoses every file when a file is added or removed', () => {
    const p = project();
    p.add(A, MAIN);
    p.add(B, FOREST);
    p.run();
    p.add(C, OTHER);
    expect([...p.run(C).keys()].sort()).toEqual([A, B, C].sort());
  });
});

describe('locationInterfaceHash', () => {
  const symbolsOf = (text: string) => {
    const name = text.slice(2, text.indexOf('\n'));
    return extractLocationSymbols(parser.parseOnce(text)!, A, name, text, t => parser.parseOnce(t));
  };
  const hash = (text: string) => locationInterfaceHash(symbolsOf(text));
  const base = `# комната\n$описание = 'тёмная комната'\nif есть: gs 'кухня', 1\npl 'текст'\n---\n`;

  it('stays when only positions or game text change', () => {
    for (const same of [
      base.replace("pl 'текст'", "pl 'другой, более длинный текст'"),
      base.replace('\nif', '\n\n! комментарий\n\nif'),
      base.replace('if есть:', 'if   есть  :'),
    ]) expect(hash(same)).toBe(hash(base));
  });

  it('changes with what other files can see', () => {
    for (const other of [
      base.replace("'тёмная комната'", "'светлая комната'"),
      base.replace("gs 'кухня', 1", "gs 'кухня', 1, 2"),
      base.replace("gs 'кухня'", "gt 'кухня'"),
      base.replace('$описание', '$описание2'),
      base.replace('# комната', '# зал'),
    ]) expect(hash(other)).not.toBe(hash(base));
  });

  it('is the same for an analysis read back from the cache, and kept by copies', () => {
    const syms = symbolsOf(base);
    expect(LocationSymbols.copyWithLineShift(syms, 40).interfaceHash).toBe(syms.interfaceHash);
    const back = compactDeserialized(v8.deserialize(v8.serialize(syms)) as LocationSymbols);
    expect(locationInterfaceHash(back)).toBe(locationInterfaceHash(syms));
  });
});
