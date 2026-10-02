import {
  CodeActionKind,
  Connection,
  DidChangeWatchedFilesNotification,
  InitializeParams,
  InitializeResult,
  DidChangeConfigurationNotification,
  TextDocumentSyncKind,
  TextDocuments,
  SemanticTokensBuilder,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  buildLocationIndex,
  DocumentSymbols,
  LocationSymbols,
  extractErrors,
  extractSymbols,
  LocationEntry,
  QspTreeSitterParser,
  computeTreeEdit,
  type SymbolLocation,
  type SyntaxError,
  type WasmLoader,
} from '../parser';
import { collectSemanticTokenTuples, SEMANTIC_TOKENS_LEGEND, GOTO_MODIFIER_BIT, NAMESPACE_TOKEN_TYPE } from './semanticTokens';
import {
  buildRegexSymbols,
  extractLocationSymbolsFromText,
  mergeActionsFromText,
  mergeLabelsFromText,
} from './regexFallback';
import { type SymbolAggregates, buildFileAggregates, collectCallTypesPerTarget as collectCallTypesPerTargetFromSymbols, isAggContributionStable } from './aggregation';
import { computeDiagnostics, type DiagnosticSettings } from './diagnostics';
import { registerLspFeatures, type DocumentState, type PerLocationParseResult } from './lspFeatures';
import { stripBom, shiftErrors, makeLocSymLoc, perLocationCacheKeys, safeSendDiagnostics, safeConnectionCall, safeConsole, QSP_FILE_EXTENSIONS, type FsProvider } from './serverUtils';
import { ProjectModeService } from './projectMode';
import { AnalysisStatusReporter } from './analysisStatus';
import { ANALYSIS_STATUS_MIN_BYTES } from '../common/analysisStatus';
import { libraryFolderPrefixes } from '../common/libraryConfig';
import { parseSuppressions } from '../common/suppressions';
import { PerfLog, formatChars, type ServerHost } from './perfLog';
import { buildPerformanceReport } from './performanceReport';
import { Pseudonyms } from './pseudonyms';
import { MemoryGuard } from './memoryGuard';
import { anonymizeCode } from '../parser/anonymize';

// Re-export FsProvider for backward compatibility.
export type { FsProvider } from './serverUtils';

/**
 * Aggregate call types per target location across all document states.
 *
 * Per-document results are cached on the DocumentState (invalidated when
 * the state object is replaced after analysis).  This avoids re-walking
 * every location and locationRef of every open document on every
 * keystroke (the dominant cost on huge files).
 */
function collectCallTypesPerTarget(
  documentStates: Map<string, DocumentState>,
): Map<string, { name: string; types: Set<string> }> {
  // Fast path: only one open document.
  if (documentStates.size === 1) {
    for (const [, ds] of documentStates) {
      if (!ds.cachedCallTypes) {
        ds.cachedCallTypes = collectCallTypesPerTargetFromSymbols([ds.symbols]);
      }
      return ds.cachedCallTypes;
    }
  }
  // Multi-document: merge per-document caches.  Each per-doc map is
  // tiny (only targets called from THAT doc), so merging is cheap.
  const merged = new Map<string, { name: string; types: Set<string> }>();
  for (const [, ds] of documentStates) {
    if (!ds.cachedCallTypes) {
      ds.cachedCallTypes = collectCallTypesPerTargetFromSymbols([ds.symbols]);
    }
    for (const [key, entry] of ds.cachedCallTypes) {
      let m = merged.get(key);
      if (!m) {
        m = { name: entry.name, types: new Set(entry.types) };
        merged.set(key, m);
      } else {
        for (const t of entry.types) m.types.add(t);
      }
    }
  }
  return merged;
}

/**
 * Build (or reuse) the per-document SymbolAggregates cache used in
 * single-file (non-project) mode.  Replaces the implicit rebuild that
 * computeDiagnostics() does on every call — dominated by
 * `buildPropagatedLocals` on huge files.
 *
 * The cache lives on `state.aggCache` and is invalidated by a fresh
 * DocumentState (analyzeDocument creates a new object each parse).
 */
function buildOrReuseFileAgg(state: DocumentState, uri: string, shouldStop?: () => boolean): SymbolAggregates {
  if (state.aggCache) return state.aggCache;
  state.aggCache = buildFileAggregates(state.symbols, uri, shouldStop);
  return state.aggCache;
}

/**
 * Collect every other document's `DocumentSymbols` for project-wide
 * resolver queries (uninitialized variables, mixed prefixes).  Empty
 * in single-file mode and when only the active document exists.
 */
function collectPeerDocs(
  documentStates: Map<string, DocumentState>,
  ownUri: string,
): DocumentSymbols[] {
  const out: DocumentSymbols[] = [];
  for (const [uri, ds] of documentStates) {
    if (uri === ownUri) continue;
    out.push(ds.symbols);
  }
  return out;
}

/** Build merged semantic tokens from per-location caches. */
function buildTokensFromCache(
  locationIndex: LocationEntry[],
  cache: Map<string, PerLocationParseResult>,
  gotoTargets?: ReadonlySet<string>,
) {
  const builder = new SemanticTokensBuilder();
  // Same key scheme as perLocationCache's writers (analyzeDocumentPerLocation /
  // tryIncrementalPerLocationUpdate) — see perLocationCacheKeys' doc comment.
  // Plain `loc.nameLower` would only ever hit the FIRST of two same-named
  // locations' cache entries, leaving every duplicate after it with no
  // semantic tokens at all.
  const cacheKeys = perLocationCacheKeys(locationIndex);
  for (const [i, loc] of locationIndex.entries()) {
    const cached = cache.get(cacheKeys[i]);
    if (!cached) continue;
    const tuples = cached.tokens;
    const isGoto = gotoTargets?.has(loc.nameLower) ?? false;
    for (let j = 0; j < tuples.length; j += 5) {
      let mod = tuples[j + 4];
      // Patch the location_name token (first namespace token at line 0)
      if (isGoto && tuples[j] === 0 && tuples[j + 3] === NAMESPACE_TOKEN_TYPE) {
        mod |= GOTO_MODIFIER_BIT;
      }
      builder.push(
        tuples[j] + loc.startLine,
        tuples[j + 1],
        tuples[j + 2],
        tuples[j + 3],
        mod,
      );
    }
  }
  return builder.build();
}

/**
 * Create and configure the QSP language server on a given connection.
 * @param wasmLoader Optional callback that provides the tree-sitter-qsp WASM.
 *   If omitted, the server runs in "lite" mode with regex-only analysis.
 * @param fsProvider Optional file-system provider for project mode (Node.js only).
 */
export function createQspServer(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  wasmLoader?: WasmLoader,
  wasmDir?: () => string,
  fsProvider?: FsProvider,
  host: ServerHost = {},
): void {
  // A debounced timer can fire after the connection is closed/disposed (test
  // teardown, client disconnect) — connection.console.* throws synchronously
  // in that case, so every log call in this module goes through this wrapper.
  const log = safeConsole(connection);
  const status = new AnalysisStatusReporter(connection);
  const perf = new PerfLog((line) => log.log(line), host.memory);
  const memoryGuard = new MemoryGuard(host.memory, (heapUsed, heapLimit) => {
    const heapMB = Math.round(heapUsed / 1048576), limitMB = Math.round(heapLimit / 1048576);
    log.warn(`[QSP] Heap at ${heapMB} of ${limitMB} MB: switching to reduced analysis until the server restarts`);
    status.setReduced({ heapMB, limitMB });
  });
  const tightOnMemory = () => memoryGuard.tight();
  const diagnose = (...args: Parameters<typeof computeDiagnostics>) => perf.step('diagnostics', () => computeDiagnostics(...args));
  const startedAt = Date.now();
  // The file analysis running right now, for reports written mid-analysis
  // (a run that crashes never finishes it).
  let analysisInProgress: { uri: string; locationIndex: readonly LocationEntry[]; parsedLocations: number } | undefined;
  // Neutral names for files and locations in reports and breadcrumbs.
  const pseudonyms = new Pseudonyms();
  let savedPseudonyms = -1;
  let workspaceFolderUris: string[] = [];
  // While the project loads, an open file's own aggregates and diagnostics
  // would be thrown away seconds later, when the project load diagnoses
  // every file with project-wide ones: for a large game that is the
  // longest step of its analysis done twice, and its memory held twice.
  // The files skipped meanwhile are here, for when no project comes.
  let projectLoadPending = false;
  const deferredDiagnostics = new Set<string>();
  const documentStates = new Map<string, DocumentState>();
  const tsParser = new QspTreeSitterParser();
  // Surface non-timeout parse failures (e.g. a WASM runtime error) in the
  // server log instead of letting them pass as silent timeouts.
  tsParser.setErrorReporter((message) => log.error(message));

  /**
   * Invalidate every open document's cached semantic tokens, then ask
   * the client to re-request them.
   *
   * A document's GOTO_MODIFIER_BIT / NAMESPACE_TOKEN_TYPE styling (see
   * semanticTokens.ts) depends on `collectCallTypesPerTarget`, which
   * merges call types across EVERY open document — not just the one
   * that just changed (see that function's doc comment). Without
   * clearing every document's `cachedSemanticTokens` here, editing
   * document B to add/remove a `gt`-style call targeting a location
   * defined in document A would leave A's cached tokens (and its
   * goto-highlighting) stale until A itself is next edited, even
   * though the client was told to refresh: our own per-document cache,
   * not the client's, would serve the stale result.
   */
  function refreshSemanticTokens(): void {
    for (const [, state] of documentStates) {
      state.cachedSemanticTokens = undefined;
    }
    safeConnectionCall(() => connection.languages.semanticTokens.refresh());
  }

  // ── User settings ──────────────────────────────────────────────────
  // QspSettings is the full configuration shape; the diagnostics half
  // is owned by ./diagnostics so adding a flag in one place compiles
  // everywhere it's used.
  interface QspSettings {
    project: { enabled: boolean };
    embeddedExec: { enabled: boolean };
    diagnostics: DiagnosticSettings;
    semanticHighlighting: { enabled: boolean };
    hover: { possibleValues: boolean; maxItemsPerCategory: number };
    debug: { performanceLog: boolean };
  }

  const defaultSettings: QspSettings = {
    project: { enabled: true },
    embeddedExec: { enabled: true },
    diagnostics: {
      duplicateLocations: true,
      duplicateLabels: true,
      duplicateActions: true,
      unreachableLabels: true,
      unclosedLocations: true,
      uninitializedVariables: true,
      unresolvedLocationRefs: true,
      unresolvedLabelRefs: true,
      unresolvedActionRefs: true,
      unresolvedObjectRefs: true,
      unusedLocations: true,
      unusedLabels: true,
      unusedVariables: true,
      unusedObjects: true,
      invalidFunctionPrefix: true,
      invalidBuiltinArgCount: true,
      deprecatedBuiltins: true,
      mixedVariablePrefixes: true,
      typeMismatch: true,
      mixedLocationCallTypes: true,
      inconsistentLocalPropagation: true,
      untrackedDynamicCalls: true,
      missingResultInFunctionCall: true,
      extraArgsToTargetWithoutArgs: true,
      shadowsCallFrameBuiltin: true,
      shadowsPropagatedLocal: true,
      maxErrorsPerLocation: 20,
      maxLocationLines: 500,
      maxPerFile: 5000,
    },
    semanticHighlighting: { enabled: true },
    hover: { possibleValues: true, maxItemsPerCategory: 20 },
    debug: { performanceLog: false },
  };
  let settings: QspSettings = defaultSettings;

  /**
   * Build QspSettings from raw VS Code configuration, falling back to
   * defaultSettings for any field with the wrong type or missing.
   * Driven by the keys of defaultSettings, so adding a diagnostic flag
   * to DiagnosticSettings + defaultSettings is the only change needed.
   */
  function parseSettingsFromConfig(qspConfig: Record<string, unknown> | undefined): QspSettings {
    const d = qspConfig?.diagnostics as Record<string, unknown> | undefined;
    const proj = qspConfig?.project as Record<string, unknown> | undefined;
    const emb = qspConfig?.embeddedExec as Record<string, unknown> | undefined;
    const sem = qspConfig?.semanticHighlighting as Record<string, unknown> | undefined;
    const hov = qspConfig?.hover as Record<string, unknown> | undefined;
    const dbg = qspConfig?.debug as Record<string, unknown> | undefined;
    const pick = <T>(v: unknown, def: T): T => typeof v === typeof def ? v as T : def;
    // settings.json isn't checked against package.json's `minimum`, so NaN,
    // fractions and negatives can arrive here.
    const pickInt = (v: unknown, def: number, min: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : def;

    const dd = defaultSettings.diagnostics;
    const diagnostics = { ...dd } as Record<string, unknown>;
    for (const key of Object.keys(dd) as (keyof DiagnosticSettings)[]) {
      diagnostics[key] = pick(d?.[key], dd[key]);
    }
    diagnostics.maxErrorsPerLocation = pickInt(d?.maxErrorsPerLocation, dd.maxErrorsPerLocation, 1);
    diagnostics.maxLocationLines = pickInt(d?.maxLocationLines, dd.maxLocationLines, 0);
    diagnostics.maxPerFile = pickInt(d?.maxPerFile, dd.maxPerFile, 0);
    diagnostics.libraryFolders = libraryFolderPrefixes(workspaceFolderUris);
    return {
      project: { enabled: pick(proj?.enabled, defaultSettings.project.enabled) },
      embeddedExec: { enabled: pick(emb?.enabled, defaultSettings.embeddedExec.enabled) },
      diagnostics: diagnostics as unknown as DiagnosticSettings,
      semanticHighlighting: { enabled: pick(sem?.enabled, defaultSettings.semanticHighlighting.enabled) },
      hover: {
        possibleValues: pick(hov?.possibleValues, defaultSettings.hover.possibleValues),
        maxItemsPerCategory: pickInt(hov?.maxItemsPerCategory, defaultSettings.hover.maxItemsPerCategory, 1),
      },
      debug: { performanceLog: pick(dbg?.performanceLog, defaultSettings.debug.performanceLog) },
    };
  }

  /** VS Code's files.encoding setting — used when reading non-open project files. */
  let fileEncoding = 'utf8';

  connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
    // The client passes a directory for the crash recorder
    // (src/client/crashReports.ts). Start before anything is parsed: the
    // initial load is where large games crash.
    workspaceFolderUris = params.workspaceFolders?.map(f => f.uri) ?? [];
    // Until the client's configuration arrives (parseSettingsFromConfig sets it too).
    settings = { ...settings, diagnostics: { ...settings.diagnostics, libraryFolders: libraryFolderPrefixes(workspaceFolderUris) } };
    // The client passes a per-workspace directory when qsp.cache.enabled is on.
    const cacheDir = (params.initializationOptions as { cacheDir?: unknown } | undefined)?.cacheDir;
    if (typeof cacheDir === 'string' && host.analysisCache) {
      try {
        project.analysisCache = host.analysisCache.open(cacheDir, (message) => log.warn(message));
      } catch (err) {
        log.warn(`[QSP] Analysis cache unavailable, analysing from scratch: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const crashDir = (params.initializationOptions as { crashDir?: unknown } | undefined)?.crashDir;
    if (typeof crashDir === 'string' && host.recorder) {
      const recorder = host.recorder;
      try {
        recorder.start(crashDir);
        perf.tracker = recorder;
        // The report needs the analysis state, so the main thread writes
        // it whenever the analysis passes a heartbeat; the recorder's own
        // thread writes the memory, heap and breadcrumb files.
        let lastReport = 0;
        perf.onHeartbeat(() => {
          if (Date.now() - lastReport < 30_000) return;
          lastReport = Date.now();
          recorder.writeJson('report', buildReport());
          savePseudonyms();
        });
        savePseudonyms();
      } catch (e) {
        log.error(`[QSP] Could not start the crash recorder: ${e}`);
      }
    }

    // Capture workspace folders for project mode. Only populated when a
    // filesystem provider is available (i.e. Node.js server, not browser)
    // — project mode is a no-op otherwise.
    if (fsProvider && params.workspaceFolders) {
      project.workspaceFolders = params.workspaceFolders.map(f => fsProvider.uriToPath(f.uri));
      // Project mode is on by default; the settings come later.
      projectLoadPending = params.workspaceFolders.length > 0;
      log.log(`[QSP] Workspace folders: ${project.workspaceFolders.join(', ')}`);
    }

    // Initialize tree-sitter in the background (non-blocking)
    if (wasmLoader) {
      try {
        await tsParser.init(wasmLoader, wasmDir);
        log.log('[QSP] Tree-sitter parser initialized');
        status.setParser('full');

        // Re-analyze all open documents now that tree-sitter is ready
        for (const doc of documents.all()) {
          analyzeDocument(doc);
        }
      } catch (e) {
        log.error(`[QSP] Tree-sitter init failed: ${e}`);
        status.setParser('failed');
        // Without tree-sitter every feature silently degrades to regex
        // analysis, so the user must hear about it. window/showMessageRequest
        // is one of the few messages allowed before the initialize response.
        safeConnectionCall(() => connection.window.showWarningMessage(
          'QSP: the tree-sitter parser failed to load, so the extension is running in limited regex mode. '
          + 'See the "QSP Language Server" output for details.',
        ));
      }
    } else {
      log.log('[QSP] Running in lite mode (no tree-sitter parser — regex-only analysis)');
      status.setParser('lite');
    }

    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: {
          triggerCharacters: ['$', '#', '%', '@', "'", '"', '.'],
          resolveProvider: true,
        },
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        renameProvider: {
          prepareProvider: true,
        },
        semanticTokensProvider: {
          legend: SEMANTIC_TOKENS_LEGEND,
          full: true,
        },
        codeActionProvider: {
          codeActionKinds: [
            CodeActionKind.QuickFix,
            CodeActionKind.RefactorExtract,
            CodeActionKind.Refactor,
            CodeActionKind.Source,
          ],
        },
        foldingRangeProvider: true,
        documentFormattingProvider: true,
        documentRangeFormattingProvider: true,
        documentHighlightProvider: true,
      },
    };
  });

  connection.onInitialized(() => {
    status.start();
    safeConnectionCall(() => connection.client.register(DidChangeConfigurationNotification.type, undefined));

    // Register file watcher for project mode
    if (fsProvider) {
      const globs = QSP_FILE_EXTENSIONS.map(ext => `**/*${ext}`);
      safeConnectionCall(() => connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: globs.map(globPattern => ({ globPattern })),
      }));
      log.log(`[QSP] Watching: ${globs.join(', ')}`);
    }

    // Read initial settings and potentially start project mode
    Promise.all([
      connection.workspace.getConfiguration({ section: 'qsp' }),
      connection.workspace.getConfiguration({ section: 'files' }),
    ]).then(async ([qspConfig, filesConfig]) => {
      fileEncoding = filesConfig?.encoding ?? 'utf8';
      settings = parseSettingsFromConfig(qspConfig as Record<string, unknown> | undefined);
      project.embeddedExecEnabled = settings.embeddedExec.enabled;
      perf.verbose = settings.debug.performanceLog;
      status.configure(settings.project.enabled ? { state: 'loading', files: 0 } : undefined);
      log.log(`[QSP] Server ready (encoding: ${fileEncoding}, project: ${settings.project.enabled}, embeddedExec: ${settings.embeddedExec.enabled})`);
      if (settings.project.enabled) {
        // Async: scans the workspace and reads/parses files off the main
        // synchronous path so other LSP requests keep being served while
        // a large project loads. See ProjectModeService.init().
        await initProject();
      } else {
        endProjectLoad();
      }
    }).catch((err: unknown) => {
      console.error('[QSP] Failed to read initial configuration:', err);
      endProjectLoad();
      // Reading the settings failed, so the defaults stay in effect; don't
      // leave the indicator spinning. A failure later, in the project scan,
      // keeps the project state it already reported.
      if (!status.isConfigured) status.configure(undefined);
    });
  });

  connection.onDidChangeWatchedFiles((params) => {
    if (!settings.project.enabled) return;
    // Apply the whole batch of changes and rebuild project aggregates
    // ONCE at the end, instead of once per changed file (a `git
    // checkout` touching hundreds of files would otherwise trigger
    // hundreds of full project rebuilds). Fire-and-forget: this is a notification
    // handler, so nothing awaits its result; rejections are caught here
    // so they can't become unhandled rejections that crash the server.
    project.handleWatchedFileChanges(
      params.changes, fsProvider, fileEncoding,
      settings.diagnostics,
      () => collectCallTypesPerTarget(documentStates),
      (ownUri: string) => collectPeerDocs(documentStates, ownUri),
    ).then(
      reportProjectSize,
      (err: unknown) => { console.error('[QSP] Failed to handle watched file changes:', err); },
    );
  });

  connection.onDidChangeConfiguration((_change) => {
    Promise.all([
      connection.workspace.getConfiguration({ section: 'qsp' }),
      connection.workspace.getConfiguration({ section: 'files' }),
    ]).then(async ([qspConfig, filesConfig]) => {
      fileEncoding = filesConfig?.encoding ?? 'utf8';
      const prevProjectEnabled = settings.project.enabled;
      const prevEmbeddedExec = settings.embeddedExec.enabled;
      settings = parseSettingsFromConfig(qspConfig as Record<string, unknown> | undefined);
      project.embeddedExecEnabled = settings.embeddedExec.enabled;
      perf.verbose = settings.debug.performanceLog;

      if (settings.embeddedExec.enabled !== prevEmbeddedExec) {
        log.log(`[QSP] embeddedExec.enabled: ${prevEmbeddedExec} → ${settings.embeddedExec.enabled}`);
      }
      // Re-analyze all open documents with new settings
      for (const doc of documents.all()) {
        analyzeDocument(doc);
      }

      // Handle project mode toggling
      if (settings.project.enabled && !prevProjectEnabled) {
        log.log('[QSP] project.enabled: false → true');
        await initProject();
      } else if (!settings.project.enabled && prevProjectEnabled) {
        log.log('[QSP] project.enabled: true → false');
        cancelProjectRediagnose();
        project.teardown();
        status.setProject(undefined);
        // Re-analyze open documents without project aggregates
        for (const doc of documents.all()) {
          analyzeDocument(doc);
        }
      } else if (settings.project.enabled) {
        projectRebuildAndReanalyze();
      }
    }).catch((err: unknown) => {
      console.error('[QSP] Failed to read updated configuration:', err);
    });
  });

  // ==================== PROJECT MODE ====================
  const project = new ProjectModeService(connection, documents, documentStates, tsParser);
  project.perf = perf;
  project.shouldStop = tightOnMemory;
  project.tracking = {
    progress: (state) => {
      analysisInProgress = state;
      trackFile(state?.uri, state?.locationIndex);
    },
  };

  // Scan the workspace, showing the scan in the language status item and,
  // since a big workspace takes a while, as a progress notification too.
  async function initProject(): Promise<void> {
    projectLoadPending = true;
    status.setProject({ state: 'loading', files: 0 });
    const progress = await connection.window.createWorkDoneProgress().catch(() => undefined);
    safeConnectionCall(() => progress?.begin('QSP: loading project', undefined, 'Scanning files…'));
    let lastReported = 0;
    try {
      await perf.phaseAsync('project load', () => project.init(
        fsProvider, fileEncoding,
        () => collectCallTypesPerTarget(documentStates),
        (ownUri: string) => collectPeerDocs(documentStates, ownUri),
        settings.diagnostics,
        (files) => {
          // Every file would flood the client during a large scan.
          if (files - lastReported < 10) return;
          lastReported = files;
          status.setProject({ state: 'loading', files });
          safeConnectionCall(() => progress?.report(`${files} files`));
        },
      ), () => `${project.projectFileUris.size} files`);
      if (project.analysisCache) {
        const { hits, misses, diagnostics } = project.cacheStats;
        log.log(`[QSP] Analysis cache: ${hits} of ${hits + misses} project files read from it, ${misses} analysed`
          + (diagnostics ? '; stored diagnostics shown first' : ''));
      }
    } finally {
      safeConnectionCall(() => progress?.done());
      if (settings.project.enabled) reportProjectSize();
      endProjectLoad();
    }
  }

  // The project load diagnosed every file, deferred ones included; if it
  // failed or project mode is off, those still need their own.
  function endProjectLoad(): void {
    projectLoadPending = false;
    const deferred = [...deferredDiagnostics];
    deferredDiagnostics.clear();
    if (settings.project.enabled && project.projectAggregates) return;
    for (const uri of deferred) {
      const doc = documents.get(uri);
      if (doc) analyzeDocument(doc);
    }
  }

  function reportProjectSize(): void {
    if (settings.project.enabled) status.setProject({ state: 'ready', files: project.projectFileUris.size });
  }

  // Helper: rebuild aggregates + re-diagnose all project files. It covers
  // everything a pending fast-tier re-diagnosis would do, so that one is dropped.
  const projectRebuildAndReanalyze = () => {
    cancelProjectRediagnose();
    project.rebuildAndReanalyzeAll(
      settings.diagnostics,
      () => collectCallTypesPerTarget(documentStates),
      (ownUri: string) => collectPeerDocs(documentStates, ownUri),
    );
  };

  // ── Fast-tier cross-file re-diagnosis ─────────────────────────────
  // When an edit changes a file's location names, the other project files
  // are re-diagnosed on a follow-up timer so their cross-file duplicate
  // errors update before the tree tier. One run is pending at a time:
  // files whose fast tiers fire together share it, and the files that
  // triggered it are skipped (their own diagnostics were just cleared and
  // the tree tier re-sends them).
  let projectRediagnoseTimer: ReturnType<typeof setTimeout> | undefined;
  const projectRediagnoseSkip = new Set<string>();

  function cancelProjectRediagnose(): void {
    if (projectRediagnoseTimer) clearTimeout(projectRediagnoseTimer);
    projectRediagnoseTimer = undefined;
    projectRediagnoseSkip.clear();
  }

  function scheduleProjectRediagnose(editedUri: string): void {
    projectRediagnoseSkip.add(editedUri);
    if (projectRediagnoseTimer) return;
    projectRediagnoseTimer = setTimeout(() => {
      const skip = new Set(projectRediagnoseSkip);
      projectRediagnoseTimer = undefined;
      projectRediagnoseSkip.clear();
      const liveAgg = project.projectAggregates;
      if (!liveAgg || !settings.project.enabled) return;
      for (const uri of project.projectFileUris) {
        if (skip.has(uri)) continue;
        const st = documentStates.get(uri);
        if (!st) continue;
        const otherDoc = documents.get(uri);
        const d = diagnose(
          otherDoc ?? null, uri, st.locationIndex,
          settings.diagnostics, tsParser,
          liveAgg.callTypesPerTarget ?? collectCallTypesPerTarget(documentStates),
          st.symbols, undefined, liveAgg,
          undefined,
          collectPeerDocs(documentStates, uri),
          st.suppressions,
        );
        safeSendDiagnostics(connection, { uri, diagnostics: d });
      }
    }, 0);
  }

  // ==================== DOCUMENT SYNC ====================

  // TextDocuments fires onDidChangeContent right after onDidOpen for the
  // same document. The open already runs the full analysis, so that change
  // event must not queue both debounce tiers again: the tree tier would
  // re-parse the whole file (seconds for a large one) for no change.
  const openedJustNow = new Set<string>();

  documents.onDidOpen((event: { document: TextDocument }) => {
    // In project mode, add to project file set
    if (settings.project.enabled) {
      project.projectFileUris.add(event.document.uri);
      if (project.projectAggregates) reportProjectSize();
    }
    openedJustNow.add(event.document.uri);
    analyzeWithStatus(event.document.uri);
  });

  let shuttingDown = false;

  // vscode-jsonrpc writes queued messages from its own setImmediate (a
  // setTimeout(0) in the browser, which has no setImmediate). Scheduling
  // with the same primitive runs `fn` after those writes, FIFO, so a
  // message sent just before is in the pipe before a long synchronous parse.
  const afterPendingWrites: (fn: () => void) => void = typeof setImmediate === 'function'
    ? (fn) => { setImmediate(fn); }
    : (fn) => { setTimeout(fn, 0); };

  /**
   * Analyze an open document, reporting it as busy when it is big enough
   * for the user to wait on. The parse is synchronous, so the busy
   * notification would otherwise leave only after it; the analysis waits
   * one event-loop turn to let the notification out first.
   */
  function analyzeWithStatus(uri: string): void {
    const doc = documents.get(uri);
    if (!doc) return;
    if (!tsParser.isReady || doc.getText().length < ANALYSIS_STATUS_MIN_BYTES) {
      analyzeDocument(doc);
      return;
    }
    status.begin(uri);
    afterPendingWrites(() => {
      try {
        const latest = documents.get(uri);
        if (latest && !shuttingDown) analyzeDocument(latest);
      } finally {
        status.end(uri);
      }
    });
  }

  /**
   * Two-tier debounce for change events:
   *  - Fast tier (150ms): rebuild location index, reuse existing symbols.
   *    Keeps outline, completions, and hover responsive during typing.
   *  - Tree tier (500ms): full tree-sitter re-parse + diagnostics.
   *    Only runs after the user pauses, so the heavy parse doesn't
   *    block the server on every keystroke.
   */
  const fastTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const treeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const DEBOUNCE_FAST_MS = 150;
  const DEBOUNCE_TREE_MS = 500;

  documents.onDidChangeContent((event: { document: TextDocument }) => {
    const uri = event.document.uri;
    if (openedJustNow.delete(uri)) return;

    // Immediately invalidate stale cached semantic tokens so that any
    // semantic-token request arriving before the tree tier fires won't
    // return tokens with outdated line positions.
    const existingState = documentStates.get(uri);
    if (existingState) existingState.cachedSemanticTokens = undefined;

    // Fast tier: location index + reuse symbols
    const existingFast = fastTimers.get(uri);
    if (existingFast) clearTimeout(existingFast);
    fastTimers.set(uri, setTimeout(() => {
      fastTimers.delete(uri);
      const latest = documents.get(uri);
      if (latest) analyzeDocumentFast(latest);
    }, DEBOUNCE_FAST_MS));

    // Tree tier: full tree-sitter parse + analysis
    const existingTree = treeTimers.get(uri);
    if (existingTree) clearTimeout(existingTree);
    treeTimers.set(uri, setTimeout(() => {
      treeTimers.delete(uri);
      analyzeWithStatus(uri);
    }, DEBOUNCE_TREE_MS));
  });

  // After shutdown only `exit` may arrive, so pending debounce timers must not
  // fire into a disposed parser. Freeing WASM memory matters for hosts that
  // keep the process alive (tests, embedders).
  connection.onShutdown(async () => {
    shuttingDown = true;
    // A recorder stopped here marks the run as ended cleanly, so the
    // client doesn't report it as a crash.
    if (host.recorder?.active) await host.recorder.stop().catch(() => []);
    status.stop();
    for (const t of fastTimers.values()) clearTimeout(t);
    for (const t of treeTimers.values()) clearTimeout(t);
    fastTimers.clear();
    treeTimers.clear();
    cancelProjectRediagnose();
    for (const state of documentStates.values()) releasePerLocationTrees(state);
    tsParser.dispose();
  });

  documents.onDidClose((event: { document: TextDocument }) => {
    const uri = event.document.uri;
    const ft = fastTimers.get(uri);
    if (ft) { clearTimeout(ft); fastTimers.delete(uri); }
    const tt = treeTimers.get(uri);
    if (tt) { clearTimeout(tt); treeTimers.delete(uri); }
    status.forget(uri);
    // Clean up retained per-location trees before discarding state.
    releasePerLocationTrees(documentStates.get(uri));
    documentStates.delete(uri);
    tsParser.removeTree(uri);
    fullParseFailedUris.delete(uri);

    // In project mode, re-read the file from disk so its symbols remain
    // in the project aggregates (the editor no longer holds the text).
    // Fire-and-forget: onDidClose is a synchronous notification handler,
    // and the read/parse is off the main path so it doesn't block other
    // requests while this file is (re-)analyzed.
    if (settings.project.enabled && fsProvider && project.projectFileUris.has(uri)) {
      const filePath = fsProvider.uriToPath(uri);
      fsProvider.readFile(filePath, fileEncoding).then(
        (text) => {
          project.analyzeFile(uri, text);
          projectRebuildAndReanalyze();
        },
        (err: unknown) => {
          // A file deleted on disk is dropped from the project by the file watcher.
          if ((err as { code?: unknown } | null)?.code === 'ENOENT') return;
          log.error(`[QSP] Failed to re-read closed project file ${filePath}: ${err}`);
        },
      ).catch((err: unknown) => {
        log.error(`[QSP] Failed to re-analyze closed project file ${filePath}: ${err}`);
      });
    } else {
      // Clear any diagnostics we previously published for this URI so
      // they don't linger in the Problems panel after the editor closes
      // the document.  In project mode the file is still part of the
      // project and projectRebuildAndReanalyze re-publishes accurate
      // diagnostics, so we skip the clear there.
      safeSendDiagnostics(connection, { uri, diagnostics: [] });
    }
  });

  /**
   * Fast-path analysis: rebuild location index and reuse existing
   * symbols so that outline / completions / hover stay responsive
   * while the user is typing.  Tree-sitter parse is deferred to the
   * tree tier (analyzeDocument) which fires on a longer debounce.
   */
  function analyzeDocumentFast(doc: TextDocument): void {
    const text = stripBom(doc.getText());
    const locationIndex = buildLocationIndex(text);

    const previousState = documentStates.get(doc.uri);
    // Reuse tree-sitter symbols if available; fall back to regex-only.
    // When reusing old symbols, line numbers may be stale — mark the
    // state so hover can show "(approximate)".
    const symbols = previousState?.symbols ?? buildRegexSymbols(doc.uri, locationIndex, text);
    const positionsApproximate = previousState?.symbols !== undefined;

    documentStates.set(doc.uri, {
      locationIndex,
      symbols,
      cachedSemanticTokens: undefined,   // stale tokens have wrong positions
      perLocationCache: previousState?.perLocationCache,
      rawText: text,
      positionsApproximate,
      suppressions: parseSuppressions(text, locationIndex),
    });

    // Clear stale diagnostics immediately so the user doesn't see
    // warnings/errors with outdated line numbers while the tree tier
    // debounce is pending.  The tree tier will send fresh diagnostics
    // once tree-sitter re-parses the document.
    safeSendDiagnostics(connection, { uri: doc.uri, diagnostics: [] });

    // In project mode, if the set of location names changed (rename,
    // add, or delete), re-diagnose all OTHER project files so their
    // cross-file duplicate errors update immediately.
    // Note: rebuildProjectAggregates and computeDiagnostics use
    // state.locationIndex (always fresh) for location name checks,
    // so no symbols.locationDefs sync is needed here.
    if (settings.project.enabled && project.projectAggregates && previousState) {
      const oldIdx = previousState.locationIndex;
      const newIdx = locationIndex;
      let changed = oldIdx.length !== newIdx.length;
      if (!changed) {
        for (let i = 0; i < oldIdx.length; i++) {
          if (oldIdx[i].nameLower !== newIdx[i].nameLower) { changed = true; break; }
        }
      }
      if (changed) {
        project.rebuildAggregates(() => collectCallTypesPerTarget(documentStates));
        scheduleProjectRediagnose(doc.uri);
      }
    }
  }

  // ── Per-location parsing threshold ─────────────────────────────────
  // Files above this byte count use per-location parsing instead of the
  // single full-document tree.  This avoids O(n²+) GLR explosion and
  // keeps incremental edits O(single_location_size).
  const PER_LOCATION_BYTE_THRESHOLD = 500_000; // 500 KB

  // Locations above this size keep their tree-sitter tree in memory
  // for incremental re-parsing (avoids ~1s full parse for 200KB locations).
  const INCREMENTAL_LOC_THRESHOLD = 50_000; // 50 KB

  // Put a cached location's symbols into `symbols` at the location's
  // lines. The document and the cache then share the object, so a large
  // file keeps one copy of its symbols, and a location that stays on the
  // same lines is handed over without copying. Returns the cache entry
  // to keep.
  function placeLocation(
    symbols: DocumentSymbols, loc: LocationEntry, locLoc: SymbolLocation, entry: PerLocationParseResult,
  ): PerLocationParseResult {
    const shift = loc.startLine - entry.symbolsLine;
    if (shift === 0) {
      symbols.adoptLocation(loc.name, locLoc, entry.symbols);
      return entry;
    }
    const placed = LocationSymbols.copyWithLineShift(entry.symbols, shift);
    symbols.adoptLocation(loc.name, locLoc, placed);
    return { ...entry, symbols: placed, symbolsLine: loc.startLine };
  }

  function releasePerLocationTrees(state: DocumentState | undefined): void {
    if (!state?.perLocationCache) return;
    for (const entry of state.perLocationCache.values()) {
      if (entry.tree) { entry.tree.delete(); entry.tree = undefined; }
    }
  }

  // Documents whose whole-file parse failed or timed out. They stay on per-location
  // parsing until closed: retrying the whole-file parse after every edit
  // would block the server for the full timeout each time.
  const fullParseFailedUris = new Set<string>();

  function analyzeDocument(doc: TextDocument): void {
    const text = stripBom(doc.getText());

    if (tsParser.isReady && (text.length >= PER_LOCATION_BYTE_THRESHOLD || fullParseFailedUris.has(doc.uri))) {
      analyzeDocumentPerLocation(doc, text);
    } else {
      trackFile(doc.uri, buildLocationIndex(text));
      try {
        perf.phase('whole-file analysis', () => analyzeDocumentFullTree(doc, text), () => formatChars(text.length));
      } finally {
        trackFile(undefined);
      }
    }
    // After the analysis: a whole-file parse that times out switches the
    // document to per-location parsing on the way.
    status.setPerLocation(
      doc.uri,
      fullParseFailedUris.has(doc.uri) ? 'timeout'
        : tsParser.isReady && text.length >= PER_LOCATION_BYTE_THRESHOLD ? 'large'
          : undefined,
    );
  }

  function analyzeDocumentFullTree(doc: TextDocument, text: string): void {
    const locationIndex = buildLocationIndex(text);
    let symbols: DocumentSymbols;

    // Get previous state for incremental symbol extraction
    const previousState = documentStates.get(doc.uri);

    // Use tree-sitter for symbol extraction if available
    let treeHasErrors = false;
    let reusedLocationNames = new Set<string>();
    if (tsParser.isReady) {
      const tree = perf.step('parse', () => tsParser.parse(doc.uri, text));
      if (!tree) {
        const label = doc.uri.split('/').pop() ?? doc.uri;
        log.warn(`[QSP] Whole-file parse of ${label} failed or timed out, switching to per-location parsing`);
        fullParseFailedUris.add(doc.uri);
        analyzeDocumentPerLocation(doc, text);
        return;
      }
      // Reuse previous symbols for unchanged locations (incremental only)
      const prevSymbols = tsParser.wasLastParseIncremental
        ? previousState?.symbols : undefined;
      const result = perf.step('symbols', () => extractSymbols(
        tree, doc.uri, prevSymbols, tsParser.lastEdit,
        settings.embeddedExec.enabled ? (t) => tsParser.parseOnce(t) : undefined,
      ));
      symbols = result.symbols;
      reusedLocationNames = result.reusedLocations;
      treeHasErrors = tree.rootNode.hasError;
    } else {
      symbols = buildRegexSymbols(doc.uri, locationIndex, text);
    }

    // Regex backfill: only when tree-sitter had parse errors.
    //
    // Why guard on treeHasErrors?  The regex locationIndex treats every
    // `#` at line-start as a location header, but inside a location body
    // `#var` (array-count operator) is valid code, not a header.
    // Tree-sitter's grammar knows the difference.  When the tree is
    // error-free, tree-sitter symbols are authoritative — running the
    // merge would risk injecting phantom locations from regex
    // false-positives.
    //
    // When tree-sitter DOES have errors, some location_block nodes end
    // up inside ERROR nodes (missed entirely by extractSymbols) or have
    // ERROR sub-nodes that swallow their act_block/label children.
    // The regex index is more resilient in that case — we bridge the
    // gap here so the Outline view stays complete during mid-edit.
    if (treeHasErrors) {
      const label = doc.uri.split('/').pop() ?? doc.uri;
      log.log(`[QSP] Tree-sitter: parse errors in ${label}`);
      for (const loc of locationIndex) {
        // Skip locations reused from a previous incremental parse —
        // they already contain merge results from the previous cycle.
        if (reusedLocationNames.has(loc.nameLower)) continue;

        const existing = symbols.getLocation(loc.name);
        if (!existing) {
          // Location completely missed by tree-sitter — add it with
          // regex-extracted actions and labels.
          const locSymbols = symbols.addLocation(loc.name, makeLocSymLoc(doc.uri, text, loc));
          extractLocationSymbolsFromText(text, loc, locSymbols, doc.uri);
        } else if (existing.hasErrors) {
          // Tree-sitter found the location but ERROR sub-nodes
          // swallowed some children — merge regex results with
          // what tree-sitter found.  We keep TS's good actions
          // (it's more accurate for valid syntax) and add only
          // regex-found actions on lines TS missed.
          mergeActionsFromText(text, loc, existing, doc.uri);
          mergeLabelsFromText(text, loc, existing, doc.uri);
        }
      }
    }

    // Whole-file analysis doesn't use perLocationCache, so trees retained
    // while the file was above PER_LOCATION_BYTE_THRESHOLD must go now.
    releasePerLocationTrees(previousState);
    // Invalidate semantic token cache — tokens are built lazily on request.
    documentStates.set(doc.uri, {
      locationIndex, symbols, cachedSemanticTokens: undefined, suppressions: parseSuppressions(text, locationIndex),
    });

    // In project mode, rebuild aggregates and re-diagnose all files
    if (settings.project.enabled && project.projectAggregates) {
      projectRebuildAndReanalyze();
    } else if (projectLoadPending) {
      deferredDiagnostics.add(doc.uri);
    } else {
      // Send diagnostics for this file only
      const state = documentStates.get(doc.uri)!;
      const fileAgg = perf.step('file aggregates', () => buildOrReuseFileAgg(state, doc.uri, tightOnMemory));
      const diagnostics = diagnose(
        doc, doc.uri, locationIndex, settings.diagnostics, tsParser,
        collectCallTypesPerTarget(documentStates), symbols,
        undefined, undefined, fileAgg,
        collectPeerDocs(documentStates, doc.uri),
        state.suppressions,
      );
      safeSendDiagnostics(connection, { uri: doc.uri, diagnostics });
    }

    // Tell VS Code to re-request semantic tokens — a prior request may
    // have been served with stale cached tokens (wrong line positions)
    // before the tree-sitter re-parse completed.
    refreshSemanticTokens();
  }

  // ── Per-location analysis for large files ──────────────────────────
  //
  // Instead of parsing the entire 5MB+ document as one tree-sitter tree
  // (which can take 20s+ for GLR with error recovery), we parse each
  // QSP location independently (~4KB average, ~1-5ms each).  On edits,
  // only the changed location is re-parsed; all others reuse cached
  // symbols/errors/tokens with adjusted line numbers.
  //
  // This reduces the per-edit cost from ~1.2s (incremental full-tree)
  // to ~10-40ms (single location re-parse + merge + diagnostics).

  /**
   * Parse a single location and return its local-coordinate results.
   * For large locations (≥INCREMENTAL_LOC_THRESHOLD), retains the tree
   * for incremental re-parsing on subsequent edits.
   *
   * @param prev Optional previous parse result — if provided and the
   *   location has a retained tree, uses incremental parsing.
   */
  function parseLocationBlock(
    locText: string,
    docUri: string,
    locationName: string,
    prev?: PerLocationParseResult,
  ): PerLocationParseResult | null {
    let tree;

    // Try incremental parsing if the previous result retained a tree.
    if (prev?.tree && prev.text !== locText) {
      const oldTree = prev.tree;
      const edit = computeTreeEdit(prev.text, locText);
      if (edit) {
        oldTree.edit(edit);
        tree = tsParser.parseOnce(locText, 5_000_000, oldTree);
      }
      // Otherwise computeTreeEdit returned null because the suffix scan
      // hit the 100 KB cap — text differs but the edit region is huge.
      // tree stays undefined, triggering the full parse path below.
      //
      // parser.parse(text, oldTree) returns a new independent tree;
      // the old tree can be safely deleted (only when we actually re-parsed).
      if (tree !== oldTree) oldTree.delete();
      prev!.tree = undefined;   // prevent double-delete in fallback below
    }

    if (!tree) {
      // Full parse (first time, or incremental parse timed out).
      // prev.tree is already cleaned up by the incremental branch above
      // if we entered it, so no double-delete risk here.
      tree = perf.step('parse', () => tsParser.parseOnce(locText));
    }

    if (!tree) return null;

    let keepTree = false;
    try {
      const embedParseFn = settings.embeddedExec.enabled
        ? (t: string) => tsParser.parseOnce(t)
        : undefined;
      const parsed = tree;
      const result = perf.step('symbols', () => extractSymbols(parsed, docUri, undefined, undefined, embedParseFn));
      const errors = perf.step('errors', () => extractErrors(parsed));
      // Short of memory, large files go without semantic highlighting
      // (TextMate still colours them).
      const tokens = tightOnMemory() ? new Uint32Array(0)
        : perf.step('semantic tokens', () => Uint32Array.from(collectSemanticTokenTuples(parsed, undefined, embedParseFn)));

      // extractSymbols wraps the location in a DocumentSymbols with one entry.
      // Get the LocationSymbols for the single location_block.
      let locSymbols: LocationSymbols | undefined;
      for (const [, ls] of result.symbols.locations) {
        locSymbols = ls;
        break; // only one location in per-location tree
      }

      // If extractSymbols found no location (e.g. entire tree is ERROR),
      // create an empty LocationSymbols so we still cache the result.
      if (!locSymbols) {
        locSymbols = new LocationSymbols(locationName);
        locSymbols.hasErrors = true;
      }

      keepTree = locText.length >= INCREMENTAL_LOC_THRESHOLD;

      return {
        text: locText,
        symbols: locSymbols,
        symbolsLine: 0,
        errors,
        tokens,
        hasErrors: tree.rootNode.hasError,
        tree: keepTree ? tree : undefined,
      };
    } finally {
      // keepTree is only set once the result is built, so a throw frees the tree too.
      if (!keepTree) tree.delete();
    }
  }

  /**
   * O(1-location) incremental update for per-location parsed files.
   *
   * Uses the current location index (rebuilt cheaply by the fast tier)
   * and compares each location's text length against the cache to find
   * the single changed location.  Re-parses only that one location
   * (using the retained tree-sitter tree for incremental parsing) and
   * reuses all other cached results.
   *
   * Returns `true` on success.  Returns `false` when the edit can't
   * be handled incrementally (structural change, multiple locations
   * changed, renamed/added/deleted locations, etc.) — the caller
   * falls back to full `analyzeDocumentPerLocation`.
   */
  function tryIncrementalPerLocationUpdate(
    doc: TextDocument,
    text: string,
    prevState: DocumentState,
  ): boolean {
    const currentIndex = prevState.locationIndex;   // current (from fast tier)
    const prevCache = prevState.perLocationCache!;  // from last full analysis
    // See perLocationCacheKeys' doc comment: plain nameLower collides on
    // duplicate location names, which would otherwise wedge this
    // function into permanently returning false (`.size` mismatch) for
    // the rest of the file's editing session.
    const currentKeys = perLocationCacheKeys(currentIndex);

    // ── 1. Same number of locations? ──────────────────────────────
    if (currentIndex.length !== prevCache.size) return false;

    // ── 2. Find the changed location via length comparison ────────
    //    For insert/delete edits, the changed location will have a
    //    different text length.  This is O(N) integer comparisons,
    //    taking microseconds for 1200 locations.
    let affIdx = -1;
    for (let i = 0; i < currentIndex.length; i++) {
      const loc = currentIndex[i];
      const prev = prevCache.get(currentKeys[i]);
      if (!prev) return false;  // new or renamed location
      const locLen = loc.endOffset - loc.startOffset;
      if (locLen !== prev.text.length) {
        if (affIdx >= 0) return false;  // multiple locations changed
        affIdx = i;
      }
    }

    // All locations have the same length — could be an equal-length
    // substitution.  Fall back to full analysis (rare case).
    if (affIdx < 0) return false;

    // ── 3. Re-parse only the changed location ─────────────────────
    const affLoc = currentIndex[affIdx];
    const newLocText = text.slice(affLoc.startOffset, affLoc.endOffset);
    const prev = prevCache.get(currentKeys[affIdx])!;

    // Verify it actually changed (guard against hash collisions etc.)
    if (prev.text === newLocText) return false;

    const result = parseLocationBlock(newLocText, doc.uri, affLoc.name, prev);
    if (!result) return false;

    // ── 4. Update cache (shallow copy + replace affected entry) ───
    const newCache = new Map(prevCache);
    newCache.set(currentKeys[affIdx], result);

    // ── 5. Build DocumentSymbols ──────────────────────────────────
    const symbols = new DocumentSymbols(doc.uri);
    const allErrors: SyntaxError[] = [];
    for (let i = 0; i < currentIndex.length; i++) {
      const loc = currentIndex[i];
      const cached = newCache.get(currentKeys[i]);
      if (!cached) continue;

      // Unchanged locations on the same lines hand over their symbols
      // as they are; shifted or changed ones get a moved copy.
      newCache.set(currentKeys[i], placeLocation(symbols, loc, makeLocSymLoc(doc.uri, text, loc), cached));
      shiftErrors(cached.errors, loc.startLine, allErrors);
    }

    // Rebuild the document-wide global-bindings index so hover
    // "Possible values", chain-tail bridging, and project-wide
    // resolvers see writes from every location.  The per-location
    // path bypasses extractSymbols at the document level, so this
    // is the only place it gets called.
    symbols.rebuildGlobalBindings();

    // ── 6. Store state (semantic tokens are built lazily on request) ──

    // Reuse the previous aggregate cache when the changed location's
    // contribution to the call graph and global variables is unchanged.
    // This avoids re-running buildPropagatedLocals (O(N) over all locs)
    // on every single-location keystroke for large files.
    const prevLocSyms = prevState.symbols.getLocation(affLoc.name);
    const aggCache = (prevState.aggCache && prevLocSyms && isAggContributionStable(prevLocSyms, result.symbols))
      ? prevState.aggCache
      : undefined;

    documentStates.set(doc.uri, {
      locationIndex: currentIndex,
      symbols,
      cachedSemanticTokens: undefined,   // rebuilt lazily
      perLocationCache: newCache,
      rawText: text,
      aggCache,
      suppressions: parseSuppressions(text, currentIndex),
    });

    // ── 7. Send diagnostics ───────────────────────────────────────
    if (settings.project.enabled && project.projectAggregates) {
      projectRebuildAndReanalyze();
    } else if (projectLoadPending) {
      deferredDiagnostics.add(doc.uri);
    } else {
      const state = documentStates.get(doc.uri)!;
      const fileAgg = perf.step('file aggregates', () => buildOrReuseFileAgg(state, doc.uri, tightOnMemory));
      const diagnostics = diagnose(
        doc, doc.uri, currentIndex, settings.diagnostics, tsParser,
        collectCallTypesPerTarget(documentStates), symbols,
        allErrors, undefined, fileAgg,
        collectPeerDocs(documentStates, doc.uri),
        state.suppressions,
      );
      safeSendDiagnostics(connection, { uri: doc.uri, diagnostics });
    }

    // Tell VS Code to re-request semantic tokens.
    refreshSemanticTokens();

    return true;
  }

  function analyzeDocumentPerLocation(doc: TextDocument, text: string): void {
    // ── Try O(1-location) incremental update first ────────────────
    // Requires: fast tier already ran (locationIndex is current) and
    // a previous full analysis populated the perLocationCache.
    const prevState = documentStates.get(doc.uri);
    if (prevState?.perLocationCache && prevState.locationIndex.length > 0) {
      if (perf.phase('location update', () => tryIncrementalPerLocationUpdate(doc, text, prevState))) return;
    }

    // Per-location parsing owns location-level trees, not a single
    // document-wide one. If this document was previously analysed by
    // analyzeDocumentFullTree (below the threshold, or on first load
    // before this size check ran), tsParser still holds that whole-file
    // tree keyed by doc.uri. Release it now: otherwise it lingers,
    // leaking WASM memory, AND `getTree(doc.uri)` (used by hover /
    // document-highlight in lspFeatures.ts) keeps returning that stale
    // tree instead of falling back to `perLocationCache` as intended.
    // Idempotent — a no-op once this document is already in
    // per-location mode.
    tsParser.removeTree(doc.uri);

    perf.phase(
      'per-location analysis',
      () => analyzeAllLocations(doc, text, prevState),
      (n) => `${n} locations, ${formatChars(text.length)}`,
    );
  }

  // Every location parsed (or reused from the cache) and merged into the
  // document's symbols. Returns the number of locations.
  function analyzeAllLocations(doc: TextDocument, text: string, prevState: DocumentState | undefined): number {
    // ── Full analysis (initial load or structural change) ─────────
    const locationIndex = buildLocationIndex(text);
    const progress = { uri: doc.uri, locationIndex, parsedLocations: 0 };
    analysisInProgress = progress;
    trackFile(doc.uri, locationIndex);
    const label = doc.uri.split('/').pop() ?? doc.uri;
    log.log(`[QSP] Per-location parse: ${label} (${locationIndex.length} locations, ${Math.round(text.length / 1024)}kb)`);
    const symbols = new DocumentSymbols(doc.uri);
    const allErrors: SyntaxError[] = [];

    // ── Change detection: reuse unchanged locations ────────────────
    const prevCache = prevState?.perLocationCache;
    const newCache = new Map<string, PerLocationParseResult>();
    // See perLocationCacheKeys' doc comment: distinct keys even when
    // two locations share a name, so neither's cache entry (and its
    // retained tree, if any) is silently overwritten/leaked by the other.
    const cacheKeys = perLocationCacheKeys(locationIndex);

    for (const [i, loc] of locationIndex.entries()) {
      progress.parsedLocations = i;
      perf.atLocation(i);
      const locText = text.slice(loc.startOffset, loc.endOffset);
      const locLoc = makeLocSymLoc(doc.uri, text, loc);
      const cacheKey = cacheKeys[i];

      // Check if we can reuse the previous parse result —
      // simple text comparison: if the location's text is identical to what
      // we cached, the parse result is still valid.
      const prev = prevCache?.get(cacheKey);
      const canReuse = prev !== undefined && prev.text === locText;

      if (canReuse && prev) {
        // Reuse cached result
        newCache.set(cacheKey, perf.step('copy into file', () => placeLocation(symbols, loc, locLoc, prev)));

        shiftErrors(prev.errors, loc.startLine, allErrors);
      } else {
        // Parse this location (incrementally if prev has a retained tree)
        const result = parseLocationBlock(locText, doc.uri, loc.name, prev);
        if (result) {
          newCache.set(cacheKey, perf.step('copy into file', () => placeLocation(symbols, loc, locLoc, result)));

          shiftErrors(result.errors, loc.startLine, allErrors);
        } else {
          // Tree-sitter failed for this location — fall back to regex
          const locSymbols = symbols.addLocation(loc.name, locLoc);
          extractLocationSymbolsFromText(text, loc, locSymbols, doc.uri);
        }
      }
    }

    // Semantic tokens are rebuilt lazily on the first SemanticTokens
    // request (see lspFeatures.ts) — flattening tokens from every
    // location into a single merged `data` array is expensive memory-wise
    // for huge files (millions of token tuples) and matches the lazy
    // behavior of both `analyzeDocumentFullTree` and
    // `tryIncrementalPerLocationUpdate`.

    // Clean up retained trees from the old cache that weren't carried
    // over to the new cache (deleted/renamed locations).
    if (prevCache) {
      for (const [key, entry] of prevCache) {
        if (!newCache.has(key) && entry.tree) {
          entry.tree.delete();
        }
      }
    }

    // Rebuild the document-wide global-bindings index (see
    // tryIncrementalPerLocationUpdate for rationale).
    perf.step('global bindings', () => symbols.rebuildGlobalBindings());
    progress.parsedLocations = locationIndex.length;

    // Store state
    documentStates.set(doc.uri, {
      locationIndex,
      symbols,
      cachedSemanticTokens: undefined,   // rebuilt lazily on first request
      perLocationCache: newCache,
      rawText: text,
      suppressions: parseSuppressions(text, locationIndex),
    });
    // From here the file is in documentStates, so a report counts it there.
    analysisInProgress = undefined;
    perf.atLocation(-1);

    // Send diagnostics (pass pre-extracted errors to skip full-tree extraction)
    if (settings.project.enabled && project.projectAggregates) {
      projectRebuildAndReanalyze();
    } else if (projectLoadPending) {
      deferredDiagnostics.add(doc.uri);
    } else {
      const state = documentStates.get(doc.uri)!;
      const fileAgg = perf.step('file aggregates', () => buildOrReuseFileAgg(state, doc.uri, tightOnMemory));
      const diagnostics = diagnose(
        doc, doc.uri, locationIndex, settings.diagnostics, tsParser,
        collectCallTypesPerTarget(documentStates), symbols,
        allErrors, undefined, fileAgg,
        collectPeerDocs(documentStates, doc.uri),
        state.suppressions,
      );
      safeSendDiagnostics(connection, { uri: doc.uri, diagnostics });
    }

    // Tell VS Code to re-request semantic tokens.
    refreshSemanticTokens();
    trackFile(undefined);
    return locationIndex.length;
  }

  // ── LSP feature handlers ────────────────────────────────────────────
  registerLspFeatures({
    connection,
    documents,
    documentStates,
    get settings() { return settings; },
    get projectAggregates() { return project.projectAggregates; },
    projectFileUris: project.projectFileUris,
    tsParser,
    collectCallTypesPerTarget: () => collectCallTypesPerTarget(documentStates),
    buildTokensFromCache: (...args: Parameters<typeof buildTokensFromCache>) =>
      perf.phase('semantic tokens', () => buildTokensFromCache(...args), () => `${args[0].length} locations`),
  });

  // ── Performance diagnostics ───────────────────────────────────────
  // See performanceReport.ts: numbers and grammar node types only, so the
  // result can be shared for games whose text can't be.
  // Tell the recorder which file is being analysed, under pseudonyms.
  function trackFile(uri: string | undefined, locationIndex?: readonly LocationEntry[]): void {
    if (!perf.tracker) return;
    if (uri === undefined || !locationIndex) {
      perf.enterFile(undefined);
      return;
    }
    perf.enterFile(pseudonyms.file(uri), locationIndex.map((loc, i) => ({
      id: pseudonyms.location(uri, i, loc.name),
      chars: loc.endOffset - loc.startOffset,
      lines: loc.endLine - loc.startLine + 1,
    })));
    savePseudonyms();
  }

  // What each pseudonym stands for, next to the recorder's files. The
  // client keeps it on the user's machine, outside the report it packs.
  function savePseudonyms(): void {
    if (!host.recorder?.active || pseudonyms.changes === savedPseudonyms) return;
    savedPseudonyms = pseudonyms.changes;
    // The workspace tells the client which window's project a crashed
    // run belongs to; like the names, it never goes into a report.
    host.recorder.writeJson('names', { workspaceFolders: workspaceFolderUris, pseudonyms: pseudonyms.table() });
  }

  // A location's code with the game taken out (parser/anonymize.ts), for
  // a crash report the user chose to extend. `locations` carries the
  // crashed run's pseudonyms so the code matches its breadcrumbs.
  connection.onRequest('qsp/anonymizedLocation', async (params: { uri: string; name: string; locations?: Record<string, string> }) => {
    if (!tsParser.isReady) return undefined;
    let text = documents.get(params.uri)?.getText();
    if (text === undefined && fsProvider) {
      text = await fsProvider.readFile(fsProvider.uriToPath(params.uri), fileEncoding).catch(() => undefined);
    }
    if (text === undefined) return undefined;
    text = stripBom(text);
    const loc = buildLocationIndex(text).find(l => l.nameLower === params.name.toLowerCase());
    if (!loc) return undefined;
    const locText = text.slice(loc.startOffset, loc.endOffset);
    const tree = tsParser.parseOnce(locText);
    if (!tree) return undefined;
    try {
      return anonymizeCode(tree, locText, { locations: new Map(Object.entries(params.locations ?? {})) });
    } finally {
      tree.delete();
    }
  });

  function buildReport() {
    return buildPerformanceReport({
      states: documentStates,
      pseudonyms,
      openUris: new Set(documents.all().map(d => d.uri)),
      parser: tsParser.isReady ? 'full' : wasmLoader ? 'not loaded' : 'lite',
      projectMode: settings.project.enabled,
      embeddedExec: settings.embeddedExec.enabled,
      uptimeSeconds: (Date.now() - startedAt) / 1000,
      memory: perf.sampleMemory(),
      aggregates: project.projectAggregates,
      inProgress: analysisInProgress,
    });
  }
  connection.onRequest('qsp/performanceReport', () => perf.phase('performance report', buildReport));

  // Start listening
  documents.listen(connection);
  connection.listen();
}
