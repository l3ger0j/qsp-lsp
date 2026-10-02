/**
 * End-to-end LSP regression test for the per-location-analysis path.
 *
 * Bug context
 * ───────────
 * Files ≥500 KB are analysed via `analyzeDocumentPerLocation` /
 * `tryIncrementalPerLocationUpdate` in src/server/common.ts.  Both
 * paths assemble a document-wide `DocumentSymbols` by transferring
 * per-location `LocationSymbols` via `addLocationFrom`, which never
 * populates the document-level `globalBindings` index.  Without an
 * explicit `symbols.rebuildGlobalBindings()` call before the new state
 * is stored, cross-document hover queries that walk the large file's
 * `globalBindings` (e.g. resolving a possible value for `$g` in a
 * small sibling document when `$g` is written in the large one) come
 * back empty.
 *
 * Test approach
 * ─────────────
 * A real `createQspServer` instance is wired up over a paired
 * `PassThrough` stream pair; a JSON-RPC client on the other end drives
 * the standard LSP handshake (`initialize` → `initialized` →
 * `didOpen` × 2 → `hover`).
 *
 *  - Big doc (>500 KB):  `# init` writes `$g = 'BIG_VALUE'`, plus a
 *    pad location to push the file past the per-location threshold.
 *  - Small doc:           reads `$g`; the cursor sits on `$g`.
 *
 * The hover result must contain `BIG_VALUE` — that string is only
 * reachable through the big file's `globalBindings`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { createConnection, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import {
  CodeActionRequest,
  ConfigurationRequest,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  RegistrationRequest,
  SemanticTokensRequest,
  type CodeAction,
  type Hover,
  type InitializeParams,
  type PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol';
import { createQspServer } from '../src/server/common';
import { fsProvider } from '../src/server/nodeHost';
import { NodeAnalysisCache, analyserSalt, nodeAnalysisCacheStore } from '../src/server/nodeCache';
import { WASM_PATH } from './testHelpers';

interface Harness {
  client: MessageConnection;
  diagnosticsFor: (uri: string) => Promise<PublishDiagnosticsParams>;
  /** The next diagnostics published for `uri`, ignoring any already received. */
  nextDiagnosticsFor: (uri: string) => Promise<PublishDiagnosticsParams>;
  /** The server's log lines so far. */
  logs: string[];
  shutdown: () => void;
}

/**
 * Spin up a real `createQspServer` on one half of a stream pair,
 * connect a JSON-RPC client to the other half, complete the LSP
 * handshake, and return helpers for sending requests / awaiting
 * diagnostics.
 */
async function startServer(
  qspConfig: Record<string, unknown> | null = null,
  // A folder on disk makes it a project: the server reads its files itself.
  workspaceDir?: string,
  cacheDir?: string,
): Promise<Harness> {
  const c2s = new PassThrough();
  const s2c = new PassThrough();

  const serverConn = createConnection(
    new StreamMessageReader(c2s),
    new StreamMessageWriter(s2c),
  );
  const documents = new TextDocuments(TextDocument);
  createQspServer(
    serverConn,
    documents,
    async () => fs.readFileSync(WASM_PATH),
    // Omit wasmDir: TreeSitter.init() with no `locateFile` resolves
    // its runtime via the Node.js module loader, which works in tests.
    // No fsProvider (unless a workspace is given) → no project files,
    // which is what most tests here want.
    undefined,
    workspaceDir ? fsProvider : undefined,
    cacheDir ? { analysisCache: nodeAnalysisCacheStore() } : {},
  );

  const client = createMessageConnection(
    new StreamMessageReader(s2c),
    new StreamMessageWriter(c2s),
  );

  // Server may register dynamic capabilities (DidChangeConfiguration);
  // accept them with a no-op response.
  client.onRequest(RegistrationRequest.type, () => null);

  // Server fetches `qsp` and `files` config sections during onInitialized;
  // return defaults so all diagnostics stay at their built-in defaults
  // unless the test passes an explicit `qsp` config override.
  client.onRequest(ConfigurationRequest.type, (params) => {
    return params.items.map(item => item.section === 'qsp' ? qspConfig : null);
  });

  // The server invalidates cached semantic tokens after each analysis
  // by calling `connection.languages.semanticTokens.refresh()`.  Return
  // null so the JSON-RPC client doesn't surface an "unhandled method"
  // rejection.
  client.onRequest('workspace/semanticTokens/refresh', () => null);

  // Bucket diagnostics by URI so tests can wait for analysis to complete.
  const diagnosticBuckets = new Map<string, PublishDiagnosticsParams>();
  const diagnosticWaiters = new Map<string, ((p: PublishDiagnosticsParams) => void)[]>();
  const nextWaiters = new Map<string, ((p: PublishDiagnosticsParams) => void)[]>();
  const logs: string[] = [];
  client.onNotification('window/logMessage', (p: { message: string }) => { logs.push(p.message); });
  client.onNotification(PublishDiagnosticsNotification.type, (params) => {
    const next = nextWaiters.get(params.uri);
    if (next) { nextWaiters.delete(params.uri); for (const w of next) w(params); }
    diagnosticBuckets.set(params.uri, params);
    const waiters = diagnosticWaiters.get(params.uri);
    if (waiters) {
      diagnosticWaiters.delete(params.uri);
      for (const w of waiters) w(params);
    }
  });

  client.listen();

  const folderUri = workspaceDir ? fsProvider.pathToUri(workspaceDir) : null;
  await client.sendRequest(InitializeRequest.type, {
    processId: process.pid,
    rootUri: folderUri,
    capabilities: {},
    workspaceFolders: folderUri ? [{ uri: folderUri, name: 'game' }] : null,
    initializationOptions: cacheDir ? { cacheDir } : undefined,
  } as InitializeParams);
  client.sendNotification(InitializedNotification.type, {});

  return {
    client,
    diagnosticsFor: (uri) => new Promise((resolve) => {
      const cached = diagnosticBuckets.get(uri);
      if (cached) { resolve(cached); return; }
      const arr = diagnosticWaiters.get(uri) ?? [];
      arr.push(resolve);
      diagnosticWaiters.set(uri, arr);
    }),
    nextDiagnosticsFor: (uri) => new Promise((resolve) => {
      const arr = nextWaiters.get(uri) ?? [];
      arr.push(resolve);
      nextWaiters.set(uri, arr);
    }),
    logs,
    shutdown: () => {
      client.dispose();
      c2s.destroy();
      s2c.destroy();
    },
  };
}

/**
 * Build a QSP document larger than the 500 KB per-location threshold
 * that defines `$g = '<marker>'` in its first location.
 */
function makeBigDocument(marker: string): string {
  const head = `# init\n$g = '${marker}'\n---\n`;
  // Pad with a single trivia-heavy location.  Comments are the cheapest
  // tree-sitter input — each line maps to a single trivia token.
  const padLine = '! ' + 'x'.repeat(120) + '\n';
  const padBody = padLine.repeat(Math.ceil(550_000 / padLine.length));
  return head + `# pad\n${padBody}---\n`;
}

describe('LSP end-to-end: per-location analysis populates globalBindings', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startServer();
  }, 30_000);

  afterAll(() => {
    h?.shutdown();
  });

  it(
    'hover on a variable in a small doc resolves a write in a >500KB sibling doc',
    async () => {
      const smallUri = 'file:///small.qsps';
      const bigUri = 'file:///big.qsps';

      // Small doc: `$x = $g` — the cursor will sit on `$g`.
      const small = `# main\n$x = $g\n---\n`;

      const big = makeBigDocument('BIG_VALUE_MARKER');
      // Sanity: the big doc must clear the per-location threshold; the
      // bug only manifests on that path.
      expect(big.length).toBeGreaterThan(500_000);

      h.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: bigUri,   languageId: 'qsp', version: 1, text: big },
      });
      h.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: smallUri, languageId: 'qsp', version: 1, text: small },
      });

      // Wait for both files to publish diagnostics — this guarantees
      // analyzeDocument has finished for each.
      await Promise.all([
        h.diagnosticsFor(bigUri),
        h.diagnosticsFor(smallUri),
      ]);

      // Hover on `$g` in the small doc (line 1, char 5 — the `g` of `$g`).
      const hover = await h.client.sendRequest(HoverRequest.type, {
        textDocument: { uri: smallUri },
        position: { line: 1, character: 5 },
      }) as Hover | null;

      expect(hover, 'hover returned null').not.toBeNull();
      const md = hover && typeof hover.contents === 'object' && 'value' in hover.contents
        ? (hover.contents as { value: string }).value
        : '';

      // The marker is reachable ONLY through the big file's
      // globalBindings index, populated by rebuildGlobalBindings().
      // Without the bugfix in common.ts, the marker is missing.
      expect(md).toContain('BIG_VALUE_MARKER');
    },
    30_000,
  );
});

// ──────────────────────────────────────────────────────────────────────
// `qsp.hover.possibleValues` setting gates the "Possible values" hover
// section.  When false, the resolver call and rendering are skipped.
// ──────────────────────────────────────────────────────────────────────

describe('LSP end-to-end: qsp.hover.possibleValues setting', () => {
  async function hoverFor(qspConfig: Record<string, unknown> | null): Promise<string> {
    const h = await startServer(qspConfig);
    try {
      const uri = 'file:///hover-gate.qsps';
      const code = `# init\n$g = 'GATED_MARKER'\n---\n# main\npl $g\n---\n`;
      h.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId: 'qsp', version: 1, text: code },
      });
      await h.diagnosticsFor(uri);
      // Position on `$g` in `pl $g` (line 4, column 4 — the `g`).
      const hover = await h.client.sendRequest(HoverRequest.type, {
        textDocument: { uri },
        position: { line: 4, character: 4 },
      }) as Hover | null;
      const md = hover && typeof hover.contents === 'object' && 'value' in hover.contents
        ? (hover.contents as { value: string }).value
        : '';
      return md;
    } finally {
      h.shutdown();
    }
  }

  it('renders "**Possible values:**" when the setting is true (default)', async () => {
    const md = await hoverFor(null);
    expect(md).toMatch(/\*\*Possible values \(\d+ definitions?\):\*\*/);
    expect(md).toContain('GATED_MARKER');
  }, 30_000);

  it('omits "**Possible values:**" when the setting is false', async () => {
    const md = await hoverFor({ hover: { possibleValues: false } });
    expect(md).not.toMatch(/\*\*Possible values[^*]*\*\*/);
    expect(md).not.toContain('GATED_MARKER');
  }, 30_000);
});

// ──────────────────────────────────────────────────────────────────────
// `qsp.hover.maxItemsPerCategory` controls the per-section item cap
// in hover tooltips.  Lowering it should truncate the "Possible values"
// list and append a "…and N more" tail.
// ──────────────────────────────────────────────────────────────────────

describe('LSP end-to-end: qsp.hover.maxItemsPerCategory setting', () => {
  async function valuesHover(qspConfig: Record<string, unknown> | null): Promise<string> {
    const h = await startServer(qspConfig);
    try {
      const uri = 'file:///hover-cap.qsps';
      // 8 distinct assignments to $g, then a read site for hover.
      const inits = Array.from({ length: 8 }, (_, i) =>
        `# init${i}\n$g = 'v${i}'\n---\n`).join('');
      const code = inits + `# main\npl $g\n---\n`;
      h.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId: 'qsp', version: 1, text: code },
      });
      await h.diagnosticsFor(uri);
      // `pl $g` lives on line (8*3 + 1) = 25.  Position on the `g` (col 4).
      const hover = await h.client.sendRequest(HoverRequest.type, {
        textDocument: { uri },
        position: { line: 25, character: 4 },
      }) as Hover | null;
      return hover && typeof hover.contents === 'object' && 'value' in hover.contents
        ? (hover.contents as { value: string }).value
        : '';
    } finally {
      h.shutdown();
    }
  }

  it('truncates the "Possible values" list when the cap is below the entry count', async () => {
    const md = await valuesHover({ hover: { maxItemsPerCategory: 3 } });
    expect(md).toMatch(/\*\*Possible values \(\d+ definitions?\):\*\*/);
    expect(md).toMatch(/…and 5 more/);
    // First 3 should be present, the 4th and beyond should not.
    expect(md).toContain("'v0'");
    expect(md).toContain("'v2'");
    expect(md).not.toContain("'v7'");
  }, 30_000);

  it('shows all entries when the cap exceeds the entry count', async () => {
    const md = await valuesHover({ hover: { maxItemsPerCategory: 50 } });
    expect(md).toMatch(/\*\*Possible values \(\d+ definitions?\):\*\*/);
    expect(md).not.toMatch(/…and \d+ more/);
    expect(md).toContain("'v7'");
  }, 30_000);
});

// ──────────────────────────────────────────────────────────────────────
// Numeric diagnostic settings are validated like `hover.maxItemsPerCategory`:
// settings.json isn't checked against package.json's `minimum`, so an
// out-of-range value must fall back to the default instead of silently
// disabling the check (`maxLocationLines: -1`) or hiding every error
// behind a summary (`maxErrorsPerLocation: 0`).
// ──────────────────────────────────────────────────────────────────────

describe('LSP end-to-end: numeric diagnostic settings validation', () => {
  async function messages(qspConfig: Record<string, unknown>, code: string): Promise<string[]> {
    const h = await startServer(qspConfig);
    try {
      const uri = 'file:///numeric-settings.qsps';
      // Let the server read `workspace/configuration` before the first analysis.
      await new Promise((r) => setTimeout(r, 200));
      h.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId: 'qsp', version: 1, text: code },
      });
      return (await h.diagnosticsFor(uri)).diagnostics.map(d => d.message);
    } finally {
      h.shutdown();
    }
  }

  it('an out-of-range maxLocationLines keeps the default limit', async () => {
    const code = `# long\n${'pl 1\n'.repeat(600)}---\n`;
    const msgs = await messages({ diagnostics: { maxLocationLines: -1 } }, code);
    expect(msgs.some(m => m.includes('lines long (max 500)'))).toBe(true);
  }, 30_000);

  it('an out-of-range maxErrorsPerLocation still reports individual errors', async () => {
    const msgs = await messages({ diagnostics: { maxErrorsPerLocation: 0 } }, `# bad\npl (1\n---\n`);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.some(m => /has \d+ syntax errors/.test(m))).toBe(false);
  }, 30_000);
});

// ──────────────────────────────────────────────────────────────────────
// Variable hover "N definitions, M usages" splits every occurrence —
// reads + compound ops (`x += 1`, `hp = hp + 5`) count as usages,
// plain `=` LHS / `local` / append writes (`$arr[] = …`) count as
// definitions.  When there's exactly one definition, its line number
// is shown inline.
// ──────────────────────────────────────────────────────────────────────

describe('LSP end-to-end: variable hover reference count', () => {
  async function hoverMd(code: string, line: number, character: number): Promise<string> {
    const h = await startServer(null);
    try {
      const uri = 'file:///ref-count.qsps';
      h.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId: 'qsp', version: 1, text: code },
      });
      await h.diagnosticsFor(uri);
      const hover = await h.client.sendRequest(HoverRequest.type, {
        textDocument: { uri }, position: { line, character },
      }) as Hover | null;
      return hover && typeof hover.contents === 'object' && 'value' in hover.contents
        ? (hover.contents as { value: string }).value
        : '';
    } finally {
      h.shutdown();
    }
  }

  it('counts `$arr[] = …` append writes as definitions', async () => {
    // 4 append writes — all definitions, no usages.
    const code = `# main
$jour_list[] = 'a'
$jour_list[] = 'b'
$jour_list[] = 'c'
$jour_list[] = 'd'
---
`;
    const md = await hoverMd(code, 1, 1); // on the `$` of `$jour_list`
    expect(md).toContain('`jour_list`');
    expect(md).toMatch(/4 definitions/);
    expect(md).not.toMatch(/usage/);
  }, 30_000);

  it('counts compound assignments (`x += 1`) as usages', async () => {
    const code = `# main
hp = 10
hp += 5
hp += 5
---
`;
    const md = await hoverMd(code, 1, 0); // on `hp`
    expect(md).toContain('`hp`');
    // 1 definition (hp = 10), 2 usages (the two compound ops).
    expect(md).toMatch(/1 definition \(line 2\)/);
    expect(md).toMatch(/2 usages/);
  }, 30_000);

  it('counts self-referential `hp = hp + 5` LHS as usage, RHS as usage', async () => {
    const code = `# main
hp = 10
hp = hp + 5
---
`;
    const md = await hoverMd(code, 1, 0);
    expect(md).toContain('`hp`');
    // line 2: definition; line 3: compound LHS + RHS read → 2 usages.
    expect(md).toMatch(/1 definition \(line 2\)/);
    expect(md).toMatch(/2 usages/);
  }, 30_000);

  it('counts plain reads as usages alongside the definition', async () => {
    const code = `# main
x = 1
pl x
pl x
pl x
---
`;
    const md = await hoverMd(code, 1, 0);
    expect(md).toContain('`x`');
    // 1 definition + 3 reads.
    expect(md).toMatch(/1 definition \(line 2\)/);
    expect(md).toMatch(/3 usages/);
  }, 30_000);
});

// ──────────────────────────────────────────────────────────────────────
// qsp/anonymizedLocation: the code a crash report may carry
// ──────────────────────────────────────────────────────────────────────
//
// The client asks the restarted server for the code of the location a
// crashed run was stuck on, with that run's pseudonyms, so the code and
// the breadcrumbs name the same locations.
describe('LSP e2e: anonymized location code for crash reports', () => {
  let h: Harness;
  beforeAll(async () => { h = await startServer(); });
  afterAll(() => h.shutdown());

  it('returns the location without its text, under the given pseudonyms', async () => {
    const uri = 'file:///game/secret.qsps';
    const text = "# Кухня\n$рецепт = 'тайный соус'\ngt 'Погреб'\n--- Кухня ---\n# Погреб\ngt 'Кухня'\n--- Погреб ---\n";
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text } });
    await h.diagnosticsFor(uri);
    const result = await h.client.sendRequest('qsp/anonymizedLocation', {
      uri, name: 'кухня', locations: { 'кухня': 'f01_l0001', 'погреб': 'f01_l0002' },
    }) as { text: string; names: Record<string, string> };
    expect(result.text).toBe("# f01_l0001\n$var_0001 = 'xxxxxxxxxxx'\ngt 'f01_l0002'\n--- xxxxx ---");
    expect(result.names).toEqual({ var_0001: 'рецепт' });
    expect(await h.client.sendRequest('qsp/anonymizedLocation', { uri, name: 'нет такой' })).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Quick fixes that silence a check
// ──────────────────────────────────────────────────────────────────────
//
// On a QSP diagnostic the server offers to ignore it on its line or in
// its location (a `!@qsp-ignore` comment), or to turn the check off (a
// client command, since only the client can write settings).
describe('LSP e2e: quick fixes that silence a check', () => {
  let h: Harness;
  beforeAll(async () => { h = await startServer(); });
  afterAll(() => h.shutdown());

  it('offers line, location and settings fixes, and the line fix silences the diagnostic', async () => {
    const uri = 'file:///game/quickfix.qsps';
    const text = '# Прихожая\n  *pl счёт\n---\n';
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text } });
    const { diagnostics } = await h.diagnosticsFor(uri);
    const uninit = diagnostics.find(d => d.code === 'uninitializedVariables')!;
    expect(uninit.data).toEqual({ name: 'счёт' });

    const actions = await h.client.sendRequest(CodeActionRequest.type, {
      textDocument: { uri }, range: uninit.range, context: { diagnostics: [uninit] },
    }) as CodeAction[];
    const fixes = actions.filter(a => a.kind === 'quickfix');
    expect(fixes.map(a => a.title)).toEqual([
      "Ignore 'uninitializedVariables' for 'счёт' on this line",
      "Ignore 'uninitializedVariables' for 'счёт' in location 'Прихожая'",
      "Turn off 'uninitializedVariables' checks in this workspace",
    ]);
    expect(fixes[0].edit!.changes![uri]).toEqual([{
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
      newText: '  !@qsp-ignore uninitializedVariables: счёт\n',
    }]);
    expect(fixes[1].edit!.changes![uri][0].range.start.line).toBe(1);
    expect(fixes[2].command).toEqual({
      title: "Turn off 'uninitializedVariables'", command: 'qsp.diagnostics.turnOff', arguments: ['uninitializedVariables'],
    });

    const fixedUri = 'file:///game/quickfix-fixed.qsps';
    const fixed = '# Прихожая\n  !@qsp-ignore uninitializedVariables: счёт\n  *pl счёт\n---\n';
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri: fixedUri, languageId: 'qsp', version: 1, text: fixed } });
    const after = await h.diagnosticsFor(fixedUri);
    expect(after.diagnostics.filter(d => d.code === 'uninitializedVariables')).toEqual([]);
  }, 30_000);

  it('offers nothing that would hide a syntax error', async () => {
    const uri = 'file:///game/quickfix-syntax.qsps';
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text: '# a\nif x = 1\n---\n' } });
    const { diagnostics } = await h.diagnosticsFor(uri);
    const syntax = diagnostics.filter(d => d.code === 'syntax');
    expect(syntax.length).toBeGreaterThan(0);
    const actions = await h.client.sendRequest(CodeActionRequest.type, {
      textDocument: { uri }, range: syntax[0].range, context: { diagnostics: syntax },
    }) as CodeAction[];
    expect(actions.filter(a => a.kind === 'quickfix')).toEqual([]);
  }, 30_000);
});

// ──────────────────────────────────────────────────────────────────────
// Syntax errors of a large open file in a project
// ──────────────────────────────────────────────────────────────────────
//
// A file past the per-location threshold has no whole-file tree, and the
// project re-diagnosis read syntax errors only from one: a large open file
// in a project showed none at all.
describe('LSP e2e: syntax errors of a large open project file', () => {
  let h: Harness;
  let dir: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-big-syntax-'));
    fs.writeFileSync(path.join(dir, 'main.qsps'), "# Прихожая\ngs 'Ошибка'\n--- Прихожая ---\n");
    h = await startServer(null, dir);
  });
  afterAll(() => { h.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('reports them after the project re-diagnoses', async () => {
    const text = makeBigDocument('большой') + '# Ошибка\nif x = 1\n--- Ошибка ---\n';
    const file = path.join(dir, 'big.qsps');
    fs.writeFileSync(file, text);
    const uri = fsProvider.pathToUri(file);
    const withSyntax = (async () => {
      for (;;) {
        const p = await h.nextDiagnosticsFor(uri);
        const syntax = p.diagnostics.filter(d => d.code === 'syntax');
        if (syntax.length > 0) return syntax;
      }
    })();
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text } });
    const syntax = await withSyntax;
    expect(syntax[0].range.start.line).toBeGreaterThan(4000);
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────
// A closed project file keeps the editor's analysis
// ──────────────────────────────────────────────────────────────────────
//
// Closing a tab re-reads the file from disk for the project. When the text
// on disk is what the editor had, its analysis is kept instead of being
// redone (seconds for a large file); otherwise the file is analysed again.
describe('LSP e2e: closing a project file', () => {
  let h: Harness;
  let dir: string;
  const files: Record<string, string> = {
    'main.qsps': "# Прихожая\ngs 'Кухня'\n--- Прихожая ---\n",
    'kitchen.qsps': "# Кухня\n*pl счёт\ngt 'нет_такой'\n--- Кухня ---\n# Сломано\nif x = 1\n--- Сломано ---\n",
  };
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-close-'));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    h = await startServer({ debug: { performanceLog: true } }, dir);
  });
  afterAll(() => { h.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

  const summary = (p: PublishDiagnosticsParams) => p.diagnostics.map(d => `${d.range.start.line}:${d.code}`).sort();
  const analyses = () => h.logs.filter(l => l.includes('[perf] project file analysis')).length;
  const kept = () => h.logs.filter(l => l.includes('[perf] closed file kept')).length;

  it('keeps the analysis of an unchanged file, and re-analyses a changed one', async () => {
    const uri = fsProvider.pathToUri(path.join(dir, 'kitchen.qsps'));
    const fromLoad = summary(await h.diagnosticsFor(uri));
    expect(fromLoad).toEqual(expect.arrayContaining(['2:unresolvedLocationRefs']));
    expect(fromLoad.some(d => d.endsWith(':syntax'))).toBe(true);

    // Unchanged: open, close, and the closed file shows what it showed.
    const opened = h.nextDiagnosticsFor(uri);
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text: files['kitchen.qsps'] } });
    await opened;
    const before = analyses();
    const closed = h.nextDiagnosticsFor(uri);
    h.client.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    expect(summary(await closed)).toEqual(fromLoad);
    expect(kept()).toBe(1);
    expect(analyses()).toBe(before);

    // Closed with unsaved edits: the file on disk differs, so it is analysed.
    const reopened = h.nextDiagnosticsFor(uri);
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text: files['kitchen.qsps'] + '# Новая\n--- Новая ---\n' } });
    await reopened;
    const closedAgain = h.nextDiagnosticsFor(uri);
    h.client.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    expect(summary(await closedAgain)).toEqual(fromLoad);
    expect(kept()).toBe(1);
    expect(analyses()).toBe(before + 1);
  }, 30_000);

  it('keeps it for a large file analysed one location at a time, syntax errors included', async () => {
    const big = makeBigDocument('большой') + "# Ошибка\nif x = 1\n--- Ошибка ---\n# Ссылка\ngt 'нет_такой'\n--- Ссылка ---\n";
    const file = path.join(dir, 'big.qsps');
    fs.writeFileSync(file, big);
    const uri = fsProvider.pathToUri(file);
    // The first diagnostics may come from the quick pass before the parse.
    const parsed = (async () => {
      for (;;) {
        const p = await h.nextDiagnosticsFor(uri);
        if (summary(p).some(d => d.endsWith(':syntax'))) return p;
      }
    })();
    h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text: big } });
    const whileOpen = summary(await parsed);
    expect(h.logs.some(l => l.includes('Per-location parse'))).toBe(true);
    expect(whileOpen.some(d => d.endsWith(':syntax'))).toBe(true);
    expect(whileOpen.some(d => d.endsWith(':unresolvedLocationRefs'))).toBe(true);
    const keptBefore = kept();
    const closed = h.nextDiagnosticsFor(uri);
    h.client.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
    expect(summary(await closed)).toEqual(whileOpen);
    expect(kept()).toBe(keptBefore + 1);
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────
// Opening a large file reuses a stored analysis
// ──────────────────────────────────────────────────────────────────────
//
// A large file opened with the text the project scan analysed (kept in
// memory) or an earlier session stored (on disk) is only parsed for its
// trees and tokens; symbols and syntax errors are taken as they are. The
// editor stores its own analysis of a file opened from scratch. Whatever
// the source, the diagnostics and the highlighting are the same.
describe('LSP e2e: opening a large file with a stored analysis', () => {
  const big = makeBigDocument('большой')
    + "# Ошибка\n*pl 'до ошибки'\nif x = 1\n--- Ошибка ---\n"
    + "# Ссылка\n$имя = 'Вася'\n*pl '<a href=\"exec:gt ''нет_ссылки''\">идти</a>'\ngt 'нет_такой'\n--- Ссылка ---\n";
  const main = "# Прихожая\ngs 'Ссылка'\n--- Прихожая ---\n";
  let root: string;
  let game: string;
  let uri: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-stored-'));
    game = path.join(root, 'game');
    fs.mkdirSync(game);
    fs.writeFileSync(path.join(game, 'main.qsps'), main);
    fs.writeFileSync(path.join(game, 'big.qsps'), big);
    uri = fsProvider.pathToUri(path.join(game, 'big.qsps'));
  });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  // Opens the big file (or `text` under its name) and returns what the editor shows for it, and the
  // per-location analysis' perf line.
  async function openBig(workspace: boolean, cacheDir?: string, text = big) {
    const h = await startServer({ debug: { performanceLog: true } }, workspace ? game : undefined, cacheDir);
    try {
      if (workspace) await h.diagnosticsFor(fsProvider.pathToUri(path.join(game, 'main.qsps')));
      // The performance log is on once the settings have arrived.
      while (!h.logs.some(l => l.includes('Server ready'))) await new Promise(r => setTimeout(r, 10));
      const parsed = (async () => {
        for (;;) {
          const p = await h.nextDiagnosticsFor(uri);
          if (p.diagnostics.some(d => d.code === 'syntax')) return p;
        }
      })();
      h.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'qsp', version: 1, text } });
      const diagnostics = (await parsed).diagnostics;
      const tokens = await h.client.sendRequest(SemanticTokensRequest.type, { textDocument: { uri } });
      const perf = h.logs.find(l => l.includes('[perf] per-location analysis'));
      return { diagnostics, tokens: tokens?.data, perf: perf ?? '' };
    } finally {
      h.shutdown();
    }
  }
  const extracted = (perf: string) => /[·,] symbols /.test(perf);

  it('takes the project scan\'s analysis, then the stored one, and gives the same result', async () => {
    const cache = path.join(root, 'cache-project');
    const fresh = await openBig(true);
    expect(extracted(fresh.perf)).toBe(true);
    expect(fresh.diagnostics.some(d => d.code === 'unresolvedLocationRefs')).toBe(true);

    const fromMemory = await openBig(true, cache);
    expect(fromMemory.perf).toContain('stored analysis');
    expect(fromMemory.perf).not.toContain('cache read');
    expect(extracted(fromMemory.perf)).toBe(false);
    expect(fromMemory.diagnostics).toEqual(fresh.diagnostics);
    expect(fromMemory.tokens).toEqual(fresh.tokens);

    const alone = await openBig(false);
    const fromDisk = await openBig(false, cache);
    expect(fromDisk.perf).toContain('cache read');
    expect(extracted(fromDisk.perf)).toBe(false);
    expect(fromDisk.diagnostics).toEqual(alone.diagnostics);
    expect(fromDisk.tokens).toEqual(alone.tokens);
  }, 120_000);

  it('stores the analysis of a file opened from scratch, equal to the project scan\'s', async () => {
    const cache = path.join(root, 'cache-editor');
    const first = await openBig(false, cache);
    expect(extracted(first.perf)).toBe(true);
    expect(first.perf).toContain('cache write');

    const again = await openBig(false, cache);
    expect(extracted(again.perf)).toBe(false);
    expect(again.diagnostics).toEqual(first.diagnostics);
    expect(again.tokens).toEqual(first.tokens);

    // The same entry the project scan wrote in the test above.
    const read = (dir: string) => {
      const c = new NodeAnalysisCache(dir, { salt: analyserSalt([]) });
      return c.get(c.key('file symbols', uri, 'exec', big));
    };
    const byEditor = read(cache);
    expect(byEditor).toBeDefined();
    expect(byEditor).toEqual(read(path.join(root, 'cache-project')));
  }, 120_000);

  it('analyses a file with two locations of one name from scratch every time', async () => {
    const cache = path.join(root, 'cache-duplicates');
    const twice = big + "# ссылка\n*pl 'вторая'\n--- ссылка ---\n";
    const first = await openBig(false, cache, twice);
    expect(first.perf).not.toContain('cache write');
    const again = await openBig(false, cache, twice);
    expect(extracted(again.perf)).toBe(true);
    expect(again.diagnostics).toEqual(first.diagnostics);
  }, 120_000);
});
