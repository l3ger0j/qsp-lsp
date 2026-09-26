# CLAUDE.md — QSP Language Support (VS Code extension + LSP)

## Architecture & Boundaries

```
src/client/   VS Code extension (the only layer allowed to import `vscode`)
              nodeMain.ts (desktop), browserMain.ts (vscode.dev), commands, txt2gam, debug adapter
src/server/   LSP server (vscode-languageserver). Transport-agnostic core in common.ts;
              nodeMain.ts = stdio + fs, browserMain.ts = Web Worker, regex "lite" mode (no tree-sitter)
src/parser/   Tree-sitter wrapper + symbol/scope/binding analysis. Pure: no server/client imports
src/common/   Shared pure helpers (location splitting, QSP string scanner, build plan, txt2gam calls)
src/mcp/      MCP server (stdio, out/mcp/server.js). Embeds the LSP server in-process and asks it over LSP;
              no `vscode` import. src/client/mcp.ts only registers it with VS Code
tree-sitter-qsp/grammar.js   Grammar source of truth (+ src/scanner.c external scanner)
qsp_grammar.peg              Ohm.js reference grammar that grammar.js was translated from. Not used by the build
syntaxes/qsp.tmLanguage.json TextMate grammar (instant coloring, separate from tree-sitter)
test/                        Vitest suites; tree-sitter-qsp/test/corpus/ = grammar corpus tests
```

Dependency direction: `client → (LSP protocol) → server → parser → common`, and `mcp → server → parser → common`.
Never the reverse.
Output bundles go to `out/` via esbuild. `out/`, `vendor/`, and generated `tree-sitter-qsp/src/*` are gitignored.

## Critical Invariants

**Parser generation boundary**
❌ Don't: edit `tree-sitter-qsp/src/parser.c`, `grammar.json`, `node-types.json` or the `.wasm` by hand (they're generated and gitignored).
✅ Do: edit `tree-sitter-qsp/grammar.js` (or `src/scanner.c`), then run `npm run build:grammar`, and `cd tree-sitter-qsp && npx tree-sitter test`.

❌ Don't: expect edits to `qsp_grammar.peg` to change parser behavior.
✅ Do: treat it as the spec. If you change semantics, update `grammar.js` and keep the `.peg` in sync.

❌ Don't: add a new statement keyword only in `grammar.js`.
✅ Do: also update `src/parser/builtins.ts` (hover/completion/arg counts), `src/parser/lookupTables.ts`,
   `syntaxes/qsp.tmLanguage.json`, and a corpus test in `tree-sitter-qsp/test/corpus/`.
   (grep an existing keyword such as `addobj` to find every place.)

**Client/server import boundary**
❌ Don't: `import * as vscode from 'vscode'` anywhere in `src/server`, `src/parser`, `src/common`.
✅ Do: keep `vscode` imports in `src/client/` only. The server talks through `vscode-languageserver` APIs.

❌ Don't: import `vscode` in `src/mcp/`, or add analysis logic there.
✅ Do: add what an MCP tool needs to the LSP server (a request, a diagnostic) and call it from `src/mcp/`,
   so agents and the editor always get the same answers.

❌ Don't: import `fs`/`path`/`node:*` in `src/server/common.ts` or `src/parser/`. The browser bundle will break.
✅ Do: put Node-specific code in `src/server/nodeMain.ts` and inject it (see the `FsProvider` pattern in `serverUtils.ts`).

**Case-insensitivity & Cyrillic**
❌ Don't: write grammar keywords as plain strings (`'goto'`) or compare names with `===` on raw text.
✅ Do: wrap keywords with `ci()`/`kw()`/`kwc()` in `grammar.js`, and key maps by `name.toLowerCase()`
   (see `locationSymbols.ts`, `walkHelpers.ts`).

❌ Don't: narrow `identifier_text` to `[A-Za-z_]` or use `\w` for QSP names. That drops Cyrillic (`$имя`, `# Локация`).
✅ Do: keep identifiers as negated character classes (current `identifier_text` regex), and add a test with Cyrillic names.

**Non-blocking parsing & caching**
❌ Don't: run a full tree-sitter parse or diagnostics synchronously inside `onDidChangeContent`.
✅ Do: respect the two-tier debounce in `common.ts` (fast 150 ms index rebuild / tree 500 ms full parse).

❌ Don't: store derived data that outlives `DocumentState`, or reuse `aggCache`/`cachedCallTypes` after the state object is replaced.
✅ Do: hang caches off `DocumentState` (`featureTypes.ts`) so they get invalidated when the state is replaced. Check `isAggContributionStable` before reusing aggregates.

❌ Don't: bypass per-location parsing for large files (≥ `PER_LOCATION_BYTE_THRESHOLD`, 500 KB).
✅ Do: keep incremental edits proportional to one location's size (`perLocationCache`, `INCREMENTAL_LOC_THRESHOLD`).

❌ Don't: assume tree-sitter is ready (browser mode, initial load).
✅ Do: guard with `tsParser.isReady` and fall back to `regexFallback.ts`.

**Comments** (explain WHY, not WHAT; if unsure whether a comment is obvious, keep it and list it for review)
❌ Don't: restate the next line or the TS signature.
   `// increment counter` above `counter++`; `// takes a string, returns a number` above `parse(input: string): number`.
✅ Do: say what the code can't — a non-obvious choice, a library workaround, a QSP rule, a side effect or ordering dependency.
   e.g. the `parser.reset()` note in `treeSitter.ts` (web-tree-sitter resumes a halted parse unless reset).

❌ Don't: leave changelog notes (authors, dates, "fixed by X") or commented-out code without a reason.
✅ Do: put history in commit messages; a TODO/FIXME must say why (and link an issue if there is one).

## Build & Verification Commands

| Task | Command |
|---|---|
| Install | `npm ci` |
| Full build (txt2gam fetch + grammar WASM + 4 bundles) | `npm run build` |
| Grammar only (generate + wasm + copy to `out/`) | `npm run build:grammar` |
| Grammar corpus tests | `cd tree-sitter-qsp && npx tree-sitter test` |
| Watch bundles | `npm run watch` |
| Type-check | `npx tsc --noEmit` |
| Unit tests (Vitest) | `npm test` (single file: `npx vitest run test/variables.test.ts`) |
| UI tests (real VS Code, @vscode/test-cli) | `npm run test:ui` (headless Linux: `xvfb-run -a npm run test:ui`) |
| Lint | `npm run lint` |
| MCP server bundle | `npm run build:mcp` (run: `node out/mcp/server.js --workspace <dir> [--verbose]`) |
| Everything CI runs (no packaging) | `npm run check` (= `scripts/build.sh --check`) |
| Package VSIX | `npm run release` (optional version: `bash scripts/build.sh 1.2.3`) |

Notes:
- `npm run build` needs network the first time (`scripts/fetchTxt2gam.mjs` downloads into `vendor/`).
- `build:grammar` copies the WASM to `out/`, so create `out/` first if it's missing (`build.sh` does `mkdir -p out`).
- CI (`.github/workflows/ci.yml`) runs `scripts/build.sh --check` on Node 22 and 24. Dev tooling (vitest 5, vsce 4) needs Node ≥ 22.12; the bundles still target node18 for VS Code ^1.85.
- `test/ui/` runs inside VS Code against a temp copy of `test/ui/fixture/` (see `.vscode-test.mjs`); Vitest excludes it.
  The first run downloads VS Code into `.vscode-test/`.

Before finishing any change: `npx tsc --noEmit && npm test && npm run lint`.
For grammar changes, also run the corpus tests above.

## Refactoring Guidelines

- **Tests first.** Test files mirror the module they cover (e.g. `variableBindings.ts` → `test/variableBindings.test.ts`).
  Use `test/testHelpers.ts`; for end-to-end LSP behavior use `test/lspE2E.test.ts`.
- **Keep `src/parser/` pure.** Functions take a tree/text and return data. No settings, connection, or timers.
- **Diagnostics go in passes.** Add a new check to the matching file in `src/server/diagnosticPasses/`,
  add a `qsp.diagnostics.<name>` toggle in `package.json` `contributes.configuration`, and wire it into `DiagnosticSettings`.
- **Both bundles must build.** After touching `src/server` or `src/common`, run `npm run build:server:browser`
  to catch accidental Node imports.
- **Embedded code** (`exec:` links, `<<expr>>` interpolation) is re-parsed via `embeddedExec.ts` / `embeddedInterpolation.ts`.
  Symbol and position changes need to handle offset mapping there as well.
- **Project mode** (`projectMode.ts`) merges symbols across files. Cross-file features must work in
  single-file mode and in project mode.
- **Semantic tokens:** if you change `SEMANTIC_TOKENS_LEGEND`, update `semanticTokenScopes` in `package.json` too.
- Match the existing style: section banners and comments as described in **Comments** below, `_`-prefixed unused args.
- Don't commit `out/`, `vendor/`, `*.vsix`, or generated tree-sitter sources.

## Comments

Content rules are in **Critical Invariants → Comments**. Style:
- Section banners: use `// ── Name ───` in new code. Leave existing `// ==== NAME ====` banners and unnamed dividers as they are.
- `/** */` JSDoc on exported functions, classes and public interface members. Internal helpers get `//` or nothing,
  unless the logic is non-obvious. Applies to new code only — existing JSDoc on internal helpers stays.
- `//` for single-line notes, not `/* */`. No comment directly above `return` unless it explains the returned expression.
