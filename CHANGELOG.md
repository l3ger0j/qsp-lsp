# Changelog

## Unreleased

### New
- **QSP Libraries** view: install, update and remove libraries from `libraries.json` catalogs (`qsp.libraries.sources`), with checksums, requirements, and a check against the game's location names before anything is written ([LIBRARIES.md](LIBRARIES.md)).
- A build (**Run**, **Export**, MCP `qsp_build`) stops when two locations share a name and lists every place: a player would reach only one of them.
- Libraries listed under `libraries` in `txt2gam.json` (sources in `libs/`) are built into `.qsp` files of their own for `inclib`, never into the game's.
- Files in `libs/` show errors only (no warnings about a library's unused locations or variables), and a duplicate location names the library it clashes with.

### Fixes
- A line starting with `--` between locations (an ASCII table, a divider) no longer breaks the highlighting and reports false syntax errors in the rest of that text: only a `#` header starts something there. Reported by Aleks Versus.

## 0.3.0

### New
- **QSP Locations** view in the Explorer: every location of the project, by file or A→Z, with error counts, the start location marked, following the cursor, and rename / duplicate / delete / find references from its context menu.
- **Jump Graph** (**QSP: Show Jump Graph**, `Ctrl+K J`): who jumps to or calls whom, in a tab beside the editor. Around a location, the whole project, or folded by file; hubs hidden, search, hover highlight, click to open a location or the place a jump is written.
  - Dynamic jumps (`gt $next`, `gt 'room_' + n`, `gt $args[0]`, `gt func('pick')`) get **possible** arrows to the locations their variables are known to name, from the nearest write before the jump, the writes before the calls into its location, or every write in the project. Nothing is run; what can't be known still goes to a **?** node.
  - Large games stay usable: a force layout in slices for ~1000 locations, arrows drawn on demand past 5000, and layout that keeps going while the panel is hidden.
- **MCP server** for AI agents: the editor's diagnostics, symbols, references and project information as MCP tools (see [MCP.md](MCP.md)); offered to VS Code agents, and **QSP: Copy MCP Server Config** for other clients.
- **Analysis status** item next to QSP in the status bar: what the server is doing, and degraded modes (**Limited mode**, **Per-location parsing**, **Reduced analysis**).
- **Crash reports**: if the language server stops unexpectedly, a report with numbers and neutral names (never game text) is saved to `.qsp/crash-reports/`, optionally with the anonymized code of the location it was stuck on (`qsp.crashReports.*`).
- Builds: per-file build mode, a configurable main file, the player executable in `txt2gam.json`, and unchanged `.qsp` files are no longer rewritten.
- Syntax errors of project files that are not open are reported.

### Large games
- Games of 1000–1500 locations (25–50 million characters) load without running out of memory: parsing is 8–12× faster, the analysis keeps within bounds on shared local names and deep call graphs, and past 70% of the heap the server drops optional analysis (**Reduced analysis**) instead of crashing.
- `qsp.diagnostics.maxPerFile` (5000) caps the diagnostics of one file.
- `[perf]` lines in the server log give each slow phase's time and memory, without names (`qsp.debug.performanceLog` logs every phase).

### Fixes
- A server crash and parse corruption on some inputs; blocking file I/O and stale trees in project mode; cache invalidation bugs; WASM memory leaks.
- Multiline expressions: operators at the start of a line, line continuations, and a newline before the closing bracket after a multiline `or`.

Earlier versions: see the [GitHub releases](https://github.com/QSPFoundation/qsp-lsp/releases).
