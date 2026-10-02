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

## Second player for Run, and Open VSX

The game-author workspace template (`qsp-game-template`) installs two
players: the classic qspgui, which **Run QSP Game** (F5) uses through
`playerExecutable` in `txt2gam.json`, and qSpider, reached only through a
task in the template's `game/.vscode/tasks.json`. A second, optional
player in `txt2gam.json` (and a command to run the game in it) would
replace that task. Publishing to Open VSX would let the template install
and update the extension like any other, instead of from a `.vsix` on
GitHub Releases pinned in its `setup/versions.env`.

## Default library catalog

**Why.** The **QSP Libraries** view finds libraries only through the
catalogs in `qsp.libraries.sources`, which is empty by default, so an
author first has to find and paste a catalog URL. The maintainer will keep
the libraries in a GitHub repository of their own; it doesn't exist yet
(organizational questions first).

**When it exists:**
- Make its `libraries.json` (e.g.
  `https://raw.githubusercontent.com/<owner>/<repo>/main/libraries.json`)
  the default of `qsp.libraries.sources` in `package.json`, and mention it
  in README.md and LIBRARIES.md.
- Put the same URL into the template's `game/.vscode/settings.json`
  (`qsp-game-template`), so older extension versions see it too.
- Set the repository up as LIBRARIES.md suggests: location names prefixed
  with the library id, and CI that recomputes each `sha256` and checks that
  no two libraries share a location name.

## Analysis cache: what is left

The cache (`src/server/nodeCache.ts`) reads unchanged project files back
instead of analysing them: on a 20 MB game of 600 locations in 10 files,
22.6 s of file analysis became 1.8 s, and the stored diagnostics appear
after 5.4 s instead of 36 s (fully checked at 16.7 s). Still open:
- **Memory.** A warm start used 1.28 GB of heap against 1.0 GB cold:
  read-back symbols probably hold their own copy of every repeated name,
  where a parse shares them. Interning strings while reviving should help;
  measure first.
- **The open file** is analysed through the editor path, not the cache
  (3.4 s on that game).
- **Yield during the aggregates and diagnostics.** On first open the server
  answers nothing for their ~10 s (hover, navigation, status updates all
  wait); doing them in slices, as the jump graph layout does, would keep it
  responsive.
- **The MCP server and VS Code for the Web** run without a cache:
  `QspHost` takes a `cacheDir` already, the MCP server would need a folder
  (e.g. under the user's cache directory); the browser would need IndexedDB.
