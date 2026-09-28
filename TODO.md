# TODO

Work that is planned but not started. Each item says why it is wanted and
what is known about doing it.

## Anonymized game skeletons

**Why.** Large games that break or slow down the analysis often can't be
shared: their text, and even their location, variable, action and object
names, may be private or unfit to send. Crash reports already carry numbers,
pseudonyms and, with consent, one anonymized location. A whole-game skeleton
would let anyone reproduce such a game's problems and run tests and
benchmarks on it, the way `scripts/stress/genGame.mjs` games are used now,
but with the real game's structure.

**What.** A command, **QSP: Export Anonymized Skeleton**, that writes a copy
of each project file with everything but the structure replaced, plus the
same code as a Node script for tests (`node out/… game.qsps`). Not Python:
it would need a QSP parser of its own that drifts from the tree-sitter
grammar.

Start from `src/parser/anonymize.ts` (one location, whitelist-based: grammar
tokens, keywords and built-ins stay, names become `var_0003`/`loc_0012`,
strings `xxx`, numbers `0`, comments go). For a whole game it must also:

- **Keep names consistent** across the game and ignoring case: one
  location, variable, action, object or label gets one pseudonym everywhere.
- **Rename names word by word**, keeping separators and digits
  (`room_12` → `w017_12`, and the string `'room_'` → `'w017_'`), so
  `gt 'room_' + n` still finds its targets.
- **Turn strings that are names into their pseudonyms** (`$to = 'forest'`,
  `gs 'go', 'hall'`, `addobj 'Sword'`), not into `xxx`, or the jump graph's
  possible edges and the name checks are lost.
- **Keep numbers**: they carry no text, and `'room_' + n`, array indices and
  conditions depend on them.
- **Anonymize code inside strings**: `exec:` links in HTML and `<<…>>`
  interpolation (including the doubled-quote bodies of older games), parsed
  the way `embeddedExec.ts` / `embeddedInterpolation.ts` do.
- **Keep sizes**: text replaced by `x` of the same length, so the skeleton
  is also good for performance measurements.
- **Keep the table** of pseudonym → name on the user's machine only, as
  crash reports do (`crash-*.names.json`), never in the skeleton.

**Check it.** After exporting, analyse the original and the skeleton and
compare what should not change: location, jump and diagnostic counts, the
`[jump graph]` statistics line, the `[perf]` shape. Equal numbers mean the
skeleton behaves like the game; a difference shows what was lost. Add tests
in the style of `test/anonymize.test.ts` that no name or text survives.

## Incremental project aggregates

On a pathological synthetic game (1500 locations, shared local names, every
location calling the others) an edit that changes a location's calls or
locals rebuilds the aggregates of the whole project: ~36 s, heap up to
2.7 GB. On real games the same step takes tens of milliseconds, so this is
for games that grow further. Rebuild only what the changed location feeds
(`buildPropagatedLocals`, `buildFileAggregates` in `src/server/`).

## Dynamic jumps through several hops

`gt $to` in a location resolves from the nearest write before the jump, else
from the nearest writes before the static jumps and calls into the location
(`src/parser/targetResolver.ts`). When the value is set two or more hops
earlier (`$to = 'x'` in A, A → B → C, `gt $to` in C) the jump stays partly
unknown; in two real games the reason `callers: not written before a call`
covers most of what is left. Follow callers of callers a few hops deep, with
a visited set: the first try without bounds overflowed the stack on the
stress games.

## Jump Graph frame rate on large views

With ~3000 arrows drawn at once (whole project of a ~1000-location game,
below the 5000-arrow on-demand threshold) panning and hovering feel slow:
every frame redraws all arrows, and hovering fades every element. Options:
lower `EDGE_BUDGET` in `src/webview/graph.ts` to ~1500, or skip the fade on
large graphs.
