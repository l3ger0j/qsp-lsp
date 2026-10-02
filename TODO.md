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

## Analysis: cache, one path, background

Done so far: the cache (`src/server/nodeCache.ts`) reads unchanged files
back instead of analysing them, keyed the same way in memory and on disk.
On a 20 MB game of 600 locations in 10 files, 22.6 s of file analysis
became 1.8 s, and the stored diagnostics appear after 5.4 s instead of
36 s (fully checked at 16.7 s). Closing an unchanged file keeps the
editor's analysis; opening a large one (past 500 KB) reuses a stored
analysis and parses nothing: a location is parsed when its semantic tokens
are asked for, the visible lines through a range request, the rest by the
full request a slice at a time. A 12.8 M-character file shows diagnostics
after 3.1 s instead of 23 s; its full tokens take 6.9 s in slices after
the project load. Trees that large locations keep for incremental edits
are freed after five minutes without use. Symbols no longer depend on the
tree they came from: scopes are keyed by position, and the variable checks
run on scope paths recorded at extraction, so every file gets the same
warnings open or closed.

Still, a file is analysed one of three ways: the project scan (closed
files), the editor's whole-file parse (open, under 500 KB) and the editor's
per-location parse (open, 500 KB and up). The goal is that "open" only
changes where the text comes from and how soon it is analysed. Next, in
order:
- **Memory.** Read-back analyses hold more than fresh ones: for a
  12.8 M-character file 336 MB against 215 MB (heap after a full GC). v8
  writes each string occurrence out in full; interning on read
  (`internStrings` in `nodeCache.ts`) brings it to 274 MB, for 0.8 s more
  on a 2.5 s read. The rest is object layout: read-back objects and arrays
  take more room than the ones the analysis built.
- **One path.** The project scan and the editor share one analysis per
  file; small open files use it too, with the whole-file tree made on demand.
- **A second hash: a file's interface.** What other files can see of a file
  (its location names, the globals it reads and writes, the calls it makes)
  hashed apart from its text, so an edit that leaves the interface alone
  doesn't re-diagnose the rest of the project.
- **Incremental aggregates.** Update the project aggregates by the changed
  file's contribution instead of rebuilding them (5 s on a 12.8 M-character
  file), and keep them in the cache keyed by the interface hashes (see also
  **Incremental project aggregates**).
- **Yield during the aggregates and diagnostics.** On first open the server
  answers nothing for their ~10 s (hover, navigation, status updates all
  wait; on the 12.8 M-character file, the 26 ms range request for the
  visible lines' tokens is answered after 8 s); doing them in slices, as
  the jump graph layout does, would keep it responsive.
- **The first analysis in worker threads,** like clangd's background index:
  files analysed in parallel, results handed to the main thread through the
  cache format; the server answers requests meanwhile.
- **A format of our own for cache entries** (long term). Instead of
  `v8.serialize`: a string table, the file's URI stored once instead of in
  every position, positions and names in flat arrays, read with
  `JSON.parse` or straight into typed arrays. It could remove the remaining
  60 MB of layout overhead and the 0.8 s of interning and make reads faster,
  but it is bound to the symbol types: do it once **One path** has settled
  them.
- **The MCP server and VS Code for the Web** run without a cache:
  `QspHost` takes a `cacheDir` already, the MCP server would need a folder
  (e.g. under the user's cache directory); the browser would need IndexedDB.
