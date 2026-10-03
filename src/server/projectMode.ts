/**
 * Project-mode service — manages multi-file workspace analysis.
 *
 * When qsp.project.enabled is true, all QSP source files in the
 * workspace are treated as parts of a single combined game file.
 * Cross-file diagnostics, completions, and navigation span all files.
 *
 * This class owns the mutable project-mode state (workspace folders,
 * aggregates, file URI set) and exposes lifecycle methods called by
 * the server's connection handlers in `common.ts`.
 */


import {
  FileChangeType,
  type Connection,
  type TextDocuments,
} from 'vscode-languageserver';
import type { Diagnostic } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import {
  buildLocationIndex,
  DocumentSymbols,
  LocationSymbols,
  reviveDocumentSymbols,
  locationInterface,
  QspSymbolKind,
  type QspSymbol,
  type SymbolLocation,
  type LocationEntry,
  type QspTreeSitterParser,
  type SyntaxError,
} from '../parser';
import {
  buildRegexSymbols,
  extractLocationSymbolsFromText,
} from './regexFallback';
import {
  type ProjectAggregates,
  collectAggregates,
  emptyAggregates,
  finishAggregates,
  propagateLocals,
  propagationBase,
  reusePropagation,
  loadPropagation,
  storedPropagation,
  type PropagationBase,
  type SymbolAggregates,
} from './aggregation';
import type { DiagnosticSettings } from './diagnostics';
import type { DocumentState } from './lspFeatures';
import { computeDiagnostics } from './diagnostics';
import { analyzeParsedLocation } from './locationAnalysis';
import { parseSuppressions } from '../common/suppressions';
import { PerfLog, formatChars } from './perfLog';
import { stripBom, makeLocSymLoc, shiftErrors, QSP_FILE_EXTENSIONS, safeSendDiagnostics, safeConnectionCall, safeConsole, type AnalysisCache, type FsProvider } from './serverUtils';

/** Yield to the event loop between files during a bulk scan, so pending
 *  LSP requests (hover, completion, …) get a turn instead of queuing
 *  behind a long run of synchronous parses. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}


/** What the analysis cache keeps for a whole project: each file's diagnostics. */
type StoredDiagnostics = Array<[uri: string, diagnostics: Diagnostic[]]>;

/** What the analysis cache keeps for one project file. */
export interface CachedFileAnalysis {
  symbols: DocumentSymbols;
  syntaxErrors: SyntaxError[];
}

export class ProjectModeService {
  /** Workspace root folders (populated on initialize). */
  workspaceFolders: string[] = [];
  /** Disk cache of per-file analysis results, when the client gave a directory for it. */
  analysisCache: AnalysisCache | undefined;
  /**
   * Files of the last project load read from the cache, and analysed for
   * lack of an entry; files re-read later (a tab closed) don't count.
   */
  cacheStats = { hits: 0, misses: 0, diagnostics: false };
  /** Cache key of each project file's analysis input, as last read from disk. */
  private readonly fileKeys = new Map<string, string>();

  /** Cached project aggregates (null when project mode is off). */
  projectAggregates: ProjectAggregates | null = null;

  /** URIs of all project files (both open and on-disk). */
  readonly projectFileUris = new Set<string>();

  /**
   * Each project file's interface (fileInterface) when every file was last
   * diagnosed: while all of them still match, an edit leaves the other
   * files' diagnostics as they are.
   */
  private diagnosedInterfaces = new Map<string, string>();

  /** The last propagation of locals across the project, reused while it holds. */
  private propagation: PropagationBase | undefined;
  /** A propagation that took this long is kept in the analysis cache for the next start. */
  propagationCacheMinMs = 500;

  /**
   * Whether to sub-parse `<a href="exec:...">` link bodies during
   * symbol extraction. Mirrored from `qsp.embeddedExec.enabled`; the
   * server updates this on configuration change.
   */
  embeddedExecEnabled = true;

  /** Times the phases below; the server replaces it with its own. */
  perf = new PerfLog(() => {});
  /** True when the server is short of memory (see memoryGuard.ts). */
  shouldStop: (() => boolean) | undefined;
  /** Told which file's per-location analysis is running, for the crash recorder. */
  tracking: {
    /** The per-location analysis running now, or undefined when it ends. */
    progress: (state: { uri: string; locationIndex: readonly LocationEntry[]; parsedLocations: number } | undefined) => void;
  } | undefined;

  constructor(
    private connection: Connection,
    private documents: TextDocuments<TextDocument>,
    private documentStates: Map<string, DocumentState>,
    private tsParser: QspTreeSitterParser,
  ) {}

  // A debounced/async operation can complete after the connection is
  // closed/disposed (test teardown, client disconnect) — connection.console.*
  // throws synchronously in that case, so logging goes through this wrapper.
  private get log(): ReturnType<typeof safeConsole> {
    return safeConsole(this.connection);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Scan workspace folders for QSP source files and populate
   * documentStates for non-open files by reading them from disk.
   *
   * Async and cooperative: `fsProvider.findFiles` is an async iterable
   * that yields to the event loop between directories, and each file is
   * `await`-read individually, so a large workspace scan no longer
   * blocks every other LSP request (hover, completion, …) for as long
   * as the whole scan takes. See the FsProvider doc comment for why.
   */
  async init(
    // Undefined in the browser: only open documents make up the project there.
    fsProvider: FsProvider | undefined,
    fileEncoding: string,
    collectCallTypes: () => Map<string, { name: string; types: Set<string> }>,
    collectPeerDocs: (ownUri: string) => DocumentSymbols[],
    diagnosticsSettings: DiagnosticSettings,
    onFileFound?: (filesSoFar: number) => void,
  ): Promise<void> {
    this.log.log('[QSP] Initializing project mode...');
    this.projectFileUris.clear();
    this.cacheStats = { hits: 0, misses: 0, diagnostics: false };

    // Discover all QSP files in workspace folders. `findFiles` already
    // yields between directories; this counter adds an extra yield every
    // few files so a single directory holding thousands of files can't
    // monopolize the event loop between those directory-level yields.
    let processedSinceYield = 0;
    if (fsProvider) {
      for (const folder of this.workspaceFolders) {
        for await (const filePath of fsProvider.findFiles(folder, QSP_FILE_EXTENSIONS)) {
          const uri = fsProvider.pathToUri(filePath);
          this.projectFileUris.add(uri);
          onFileFound?.(this.projectFileUris.size);

          // If not already open in editor, read from disk and analyze
          if (!this.documents.get(uri)) {
            try {
              const text = await fsProvider.readFile(filePath, fileEncoding);
              this.analyzeFile(uri, text, true);
            } catch (e) {
              this.log.error(`[QSP] Failed to read project file ${filePath}: ${e}`);
            }
          }

          if (++processedSinceYield >= 20) {
            processedSinceYield = 0;
            await yieldToEventLoop();
          }
        }
      }
    }

    // Also add all currently open documents
    for (const doc of this.documents.all()) {
      this.projectFileUris.add(doc.uri);
    }

    // What the project showed last time it was in this exact state, shown
    // now; the aggregates and diagnostics below take seconds on a large
    // game and then replace it.
    const diagnosticsKey = this.projectDiagnosticsKey(diagnosticsSettings);
    if (diagnosticsKey) await this.publishStoredDiagnostics(diagnosticsKey);

    // Build aggregates and re-diagnose everything
    const published = diagnosticsKey ? new Map<string, Diagnostic[]>() : undefined;
    this.rebuildAndReanalyzeAll(diagnosticsSettings, collectCallTypes, collectPeerDocs, published);
    if (diagnosticsKey && published && this.analysisCache) {
      const entry: StoredDiagnostics = [...published];
      this.perf.step('cache write', () => this.analysisCache!.put(diagnosticsKey, entry));
    }

    this.log.log(
      `[QSP] Project mode initialized with ${this.projectFileUris.size} files`,
    );
  }

  /** Tear down project mode: clear non-open file states, clear aggregates. */
  teardown(): void {
    this.log.log('[QSP] Tearing down project mode');

    // Clear diagnostics for non-open files
    for (const uri of this.projectFileUris) {
      if (!this.documents.get(uri)) {
        safeSendDiagnostics(this.connection, { uri, diagnostics: [] });
        this.documentStates.delete(uri);
      }
    }

    this.projectFileUris.clear();
    this.diagnosedInterfaces.clear();
    this.propagation = undefined;
    this.projectAggregates = null;
  }

  /**
   * The cache key of the project's diagnostics: every file's input (open
   * files by their current text, which may be unsaved) and the diagnostic
   * settings, library folders included. Undefined without a cache, or
   * while a file's analysis wasn't keyed (the regex fallback).
   */
  private projectDiagnosticsKey(settings: DiagnosticSettings): string | undefined {
    const cache = this.analysisCache;
    if (!cache || !this.tsParser.isReady) return undefined;
    const inputs: string[] = [];
    for (const uri of [...this.projectFileUris].sort()) {
      const open = this.documents.get(uri);
      const fileKey = open
        ? cache.key('open file', uri, this.embeddedExecEnabled ? 'exec' : 'no exec', open.getText())
        : this.fileKeys.get(uri);
      if (!fileKey) return undefined;
      inputs.push(`${uri}\n${fileKey}`);
    }
    return cache.key('project diagnostics', inputs.join('\n'), JSON.stringify(settings));
  }

  /**
   * Send the diagnostics stored under `key`, and wait until they are on
   * their way: messages leave only while the event loop runs, one write at
   * a time, and the aggregates that follow hold the loop for seconds.
   */
  private async publishStoredDiagnostics(key: string): Promise<void> {
    const stored = this.perf.step('cache read', () => this.analysisCache?.get(key)) as StoredDiagnostics | undefined;
    if (!Array.isArray(stored)) return;
    this.cacheStats.diagnostics = true;
    const sent: Promise<unknown>[] = [];
    for (const item of stored) {
      if (!Array.isArray(item) || typeof item[0] !== 'string' || !Array.isArray(item[1])) continue;
      if (!this.projectFileUris.has(item[0])) continue;
      safeConnectionCall(() => {
        const p = this.connection.sendDiagnostics({ uri: item[0], diagnostics: item[1] });
        sent.push(p);
        return p;
      });
    }
    // A client that stops reading must not hold up the analysis.
    await Promise.race([Promise.allSettled(sent), new Promise(resolve => setTimeout(resolve, 2000))]);
  }

  /**
   * Keep the analysis an editor made of a file that has just closed, its
   * text unchanged on disk, instead of analysing it again. Not stored in
   * the cache: only a project analysis is (see analyzeFileNow).
   */
  keepFile(uri: string, text: string, symbols: DocumentSymbols, syntaxErrors: SyntaxError[]): void {
    this.perf.phase('closed file kept', () => {
      const locationIndex = buildLocationIndex(text);
      const key = this.analysisKey(uri, text);
      this.documentStates.set(uri, {
        locationIndex,
        symbols,
        cachedSemanticTokens: undefined,
        syntaxErrors,
        storedAnalysis: key ? { key, syntaxErrors } : undefined,
        suppressions: parseSuppressions(text, locationIndex),
      });
    }, () => formatChars(text.length));
  }

  /**
   * The analysis cache key of a file's symbols and syntax errors: they
   * depend only on its text, its URI (stored in every location) and
   * whether exec: links are analysed; the analyser itself is part of every
   * key (nodeCache.ts). Undefined without a cache or a parser.
   */
  analysisKey(uri: string, text: string): string | undefined {
    if (!this.tsParser.isReady) return undefined;
    return this.analysisCache?.key('file symbols', uri, this.embeddedExecEnabled ? 'exec' : 'no exec', text);
  }

  /** The analysis stored on disk under `key`. */
  readAnalysis(key: string): CachedFileAnalysis | undefined {
    const hit = this.perf.step('cache read', () => this.analysisCache?.get(key)) as CachedFileAnalysis | undefined;
    const symbols = reviveDocumentSymbols(hit?.symbols);
    return symbols && Array.isArray(hit?.syntaxErrors) ? { symbols, syntaxErrors: hit.syntaxErrors } : undefined;
  }

  /** Store a complete analysis of the text `key` was made from (see analysisKey). */
  storeAnalysis(key: string, symbols: DocumentSymbols, syntaxErrors: SyntaxError[]): void {
    const entry: CachedFileAnalysis = { symbols, syntaxErrors };
    this.perf.step('cache write', () => this.analysisCache?.put(key, entry));
  }

  /**
   * Analyze a project file that isn't open in the editor.
   * Creates a DocumentState from the raw text.
   */
  analyzeFile(uri: string, text: string, partOfLoad = false): void {
    this.perf.phase('project file analysis', () => this.analyzeFileNow(uri, text, partOfLoad), () => formatChars(text.length));
  }

  private analyzeFileNow(uri: string, text: string, partOfLoad: boolean): void {
    const locationIndex = buildLocationIndex(text);
    let symbols: DocumentSymbols | undefined;
    // Kept on the state because the tree is freed here: without them a
    // syntax error in a closed file would show only once it is opened.
    let syntaxErrors: SyntaxError[] | undefined;
    // Without a parser there is no key: results of the regex fallback are
    // never stored, they are poorer than a full parse.
    const key = this.analysisKey(uri, text);
    if (key) this.fileKeys.set(uri, key);
    let cacheable = key !== undefined;
    if (key) {
      const hit = this.readAnalysis(key);
      if (hit) {
        ({ symbols, syntaxErrors } = hit);
        if (partOfLoad) this.cacheStats.hits++;
        cacheable = false;
      } else if (partOfLoad) {
        this.cacheStats.misses++;
      }
    }

    if (symbols) {
      // From the cache.
    } else if (!this.tsParser.isReady) {
      symbols = buildRegexSymbols(uri, locationIndex, text);
    } else {
      syntaxErrors = [];
      symbols = this.analyzePerLocation(uri, text, locationIndex, syntaxErrors);
    }
    if (cacheable && key) this.storeAnalysis(key, symbols, syntaxErrors ?? []);

    this.documentStates.set(uri, {
      locationIndex,
      symbols,
      cachedSemanticTokens: undefined,
      syntaxErrors,
      storedAnalysis: key ? { key, syntaxErrors: syntaxErrors ?? [] } : undefined,
      suppressions: parseSuppressions(text, locationIndex),
    });
  }

  // One location at a time, like the editor (locationAnalysis.ts): a
  // closed file gets the symbols an open one does.
  private analyzePerLocation(
    uri: string,
    text: string,
    locationIndex: LocationEntry[],
    syntaxErrors: SyntaxError[],
  ): DocumentSymbols {
    const symbols = new DocumentSymbols(uri);
    const progress = { uri, locationIndex, parsedLocations: 0 };
    this.tracking?.progress(progress);
    for (const [i, loc] of locationIndex.entries()) {
      progress.parsedLocations++;
      this.perf.atLocation(i);
      const locText = text.slice(loc.startOffset, loc.endOffset);
      const locLoc = makeLocSymLoc(uri, text, loc);
      const tree = this.perf.step('parse', () => this.tsParser.parseOnce(locText));
      if (tree) {
        let parsed: ReturnType<typeof analyzeParsedLocation>;
        try {
          parsed = analyzeParsedLocation(
            tree, uri, loc.name, locText,
            this.embeddedExecEnabled ? (t) => this.tsParser.parseOnce(t) : undefined,
            (name, fn) => this.perf.step(name, fn),
          );
        } finally {
          tree.delete();
        }
        shiftErrors(parsed.errors, loc.startLine, syntaxErrors);
        this.perf.step('copy into file', () => symbols.addLocationFrom(loc.name, locLoc, parsed.symbols, loc.startLine));
      } else {
        // Tree-sitter failed (timeout) for this one location — fall
        // back to regex extraction for just that location.
        const locSymbols = symbols.addLocation(loc.name, locLoc);
        extractLocationSymbolsFromText(text, loc, locSymbols, uri);
      }
    }
    this.tracking?.progress(undefined);
    symbols.rebuildGlobalBindings();
    return symbols;
  }

  // ── Aggregate management ────────────────────────────────────────────

  /** Build a minimal QspSymbol for a location that is in locationIndex
   *  but not yet in symbols.locationDefs (fast-tier window). */
  private placeholderLocationDef(uri: string, loc: LocationEntry): QspSymbol {
    const col = 1; // '#' prefix (spaces before name are optional)
    const symLoc: SymbolLocation = {
      uri, line: loc.startLine, column: col,
      endLine: loc.startLine, endColumn: col + loc.name.length,
    };
    return {
      name: loc.name,
      nameLower: loc.nameLower,
      kind: QspSymbolKind.Location,
      definition: symLoc,
      references: [symLoc],
      isLocal: false,
    };
  }

  /**
   * Rebuild the complete project aggregates from all known files.
   * Returns the new `ProjectAggregates` and stores it on `this.projectAggregates`.
   *
   * @param collectCallTypes — callback that builds the merged call-type map
   *   from all open document states (defined in `common.ts` to avoid circular imports).
   */
  rebuildAggregates(
    collectCallTypes: () => Map<string, { name: string; types: Set<string> }>,
  ): ProjectAggregates {
    const agg: ProjectAggregates = {
      locationDefs: new Map(),
      ...emptyAggregates(),
      firstLocationKey: undefined,
      flatLocationDefs: new Map(),
      perFileLocNames: new Map(),
      callTypesPerTarget: new Map(),
    };

    // Determine the "first" location across the entire project
    // (for unused-location exemption). Use a deterministic order:
    // sort file URIs, first location in the first file wins.
    const sortedUris = [...this.projectFileUris].sort();
    for (const uri of sortedUris) {
      const state = this.documentStates.get(uri);
      if (state && state.locationIndex.length > 0) {
        agg.firstLocationKey = state.locationIndex[0].nameLower;
        break;
      }
    }

    for (const uri of this.projectFileUris) {
      const state = this.documentStates.get(uri);
      if (!state) continue;

      // Build per-file location name set (for cross-file duplicate detection)
      const names = new Set<string>();
      for (const loc of state.locationIndex) {
        names.add(loc.nameLower);
      }
      agg.perFileLocNames.set(uri, names);

      // Location defs — driven by locationIndex (always fresh) rather
      // than symbols.locationDefs which may lag during the fast tier.
      for (const loc of state.locationIndex) {
        const key = loc.nameLower;
        if (!agg.locationDefs.has(key)) {
          const sym = state.symbols.locationDefs.get(key)
            ?? this.placeholderLocationDef(uri, loc);
          agg.locationDefs.set(key, { uri, symbol: sym });
        }
        // Duplicates are detected in computeDiagnostics
      }

      collectAggregates(state.symbols.locations.values(), agg);
    }

    // Build transitive propagated-locals from the call graph
    {
      const allLocs: { locName: string; locSyms: LocationSymbols; uri: string }[] = [];
      for (const uri of this.projectFileUris) {
        const state = this.documentStates.get(uri);
        if (!state) continue;
        for (const [, locSyms] of state.symbols.locations) {
          allLocs.push({ locName: locSyms.locationName, locSyms, uri });
        }
      }
      // Seconds in a large game: an edit that changes no location's
      // interface (game text, comments, new lines) keeps the last one.
      const reused = this.perf.step('propagation reuse', () => reusePropagation(this.propagation, allLocs, agg, this.shouldStop))
        || this.perf.step('propagation cache read', () => this.readPropagation(allLocs, agg));
      if (!reused) {
        const started = performance.now();
        this.perf.step('propagation', () => propagateLocals(allLocs, agg, this.shouldStop));
        // Most games' propagation takes milliseconds, less than reading it back.
        if (performance.now() - started >= this.propagationCacheMinMs && !this.shouldStop?.()) {
          this.perf.step('propagation cache write', () => this.storePropagation(allLocs, agg));
        }
      }
      this.perf.step('aggregates finish', () => finishAggregates(allLocs, agg));
      this.propagation = propagationBase(allLocs, agg);
    }

    // Build the flat map once (used by computeDiagnostics)
    for (const [key, entry] of agg.locationDefs) {
      agg.flatLocationDefs.set(key, entry.symbol);
    }

    // Build call-type aggregation once (used by semantic tokens + diagnostics)
    agg.callTypesPerTarget = collectCallTypes();

    this.projectAggregates = agg;
    return agg;
  }

  // The analysis cache key of the propagation of these locations: it reads
  // only what their interfaces cover (see reusePropagation).
  private propagationKey(allLocs: ReadonlyArray<{ locSyms: LocationSymbols; uri: string }>): string | undefined {
    return this.analysisCache?.key('propagation', ...allLocs.map(({ uri, locSyms }) =>
      `${uri}\n${locSyms.locationName}\n${locationInterface(locSyms)}`));
  }

  private readPropagation(allLocs: ReadonlyArray<{ locName: string; locSyms: LocationSymbols; uri: string }>, agg: SymbolAggregates): boolean {
    const key = this.propagationKey(allLocs);
    return key !== undefined && loadPropagation(this.analysisCache!.get(key), allLocs, agg);
  }

  private storePropagation(allLocs: ReadonlyArray<{ locName: string; locSyms: LocationSymbols; uri: string }>, agg: SymbolAggregates): void {
    const key = this.propagationKey(allLocs);
    const stored = key !== undefined ? storedPropagation(agg, allLocs) : undefined;
    if (stored) this.analysisCache!.put(key!, stored);
  }

  // ── Diagnostics ─────────────────────────────────────────────────────

  /**
   * Re-diagnose all project files using the current project aggregates.
   */
  reanalyzeAll(
    diagnosticsSettings: DiagnosticSettings,
    collectCallTypes: () => Map<string, { name: string; types: Set<string> }>,
    collectPeerDocs: (ownUri: string) => DocumentSymbols[],
    getDoc: (uri: string) => TextDocument | undefined,
    collected?: Map<string, Diagnostic[]>,
    only?: ReadonlySet<string>,
  ): number {
    if (!this.projectAggregates) return 0;
    let published = 0;

    const callTypes = this.projectAggregates.callTypesPerTarget ?? collectCallTypes();

    for (const uri of this.projectFileUris) {
      if (only && !only.has(uri)) continue;
      const state = this.documentStates.get(uri);
      if (!state) continue;

      const doc = getDoc(uri);
      const diagnostics = computeDiagnostics(
        doc ?? null,
        uri,
        state.locationIndex,
        diagnosticsSettings,
        callTypes,
        state.symbols,
        state.syntaxErrors,
        this.projectAggregates,
        undefined,
        collectPeerDocs(uri),
        state.suppressions,
      );
      published += diagnostics.length;
      collected?.set(uri, diagnostics);
      safeSendDiagnostics(this.connection, { uri, diagnostics });
    }
    return published;
  }

  /**
   * Rebuild the aggregates, then diagnose the project files again: only
   * `changed` when no file's interface differs from when they were all last
   * diagnosed (the others' diagnostics can't have changed), every file
   * otherwise or without `changed`.
   */
  rebuildAndReanalyzeAll(
    diagnosticsSettings: DiagnosticSettings,
    collectCallTypes: () => Map<string, { name: string; types: Set<string> }>,
    collectPeerDocs: (ownUri: string) => DocumentSymbols[],
    collected?: Map<string, Diagnostic[]>,
    changed?: readonly string[],
  ): void {
    this.perf.phase('project aggregates', () => this.rebuildAggregates(collectCallTypes), () => `${this.projectFileUris.size} files`);
    const interfaces = new Map<string, string>();
    for (const uri of this.projectFileUris) {
      const iface = this.fileInterface(uri);
      if (iface !== undefined) interfaces.set(uri, iface);
    }
    const only = changed && interfaces.size === this.projectFileUris.size
      && interfaces.size === this.diagnosedInterfaces.size
      && [...interfaces].every(([uri, iface]) => this.diagnosedInterfaces.get(uri) === iface)
      ? new Set(changed)
      : undefined;
    this.perf.phase('project diagnostics', () => this.reanalyzeAll(
      diagnosticsSettings, collectCallTypes, collectPeerDocs,
      uri => this.documents.get(uri), collected, only,
    ), (n) => `${only ? `${only.size} of ` : ''}${this.projectFileUris.size} files, ${n} diagnostics`);
    if (!only) this.diagnosedInterfaces = interfaces;
  }

  /**
   * The project files were diagnosed apart from rebuildAndReanalyzeAll (the
   * fast tier's re-diagnosis): the next edit diagnoses every file again.
   */
  forgetDiagnosedInterfaces(): void {
    this.diagnosedInterfaces.clear();
  }

  /**
   * What the other files can see of `uri`: its locations' names and
   * interface hashes, in order. Undefined while its symbols lag behind its
   * text (the fast tier).
   */
  private fileInterface(uri: string): string | undefined {
    const state = this.documentStates.get(uri);
    if (!state || state.positionsApproximate) return undefined;
    const parts: string[] = [];
    for (const loc of state.locationIndex) {
      const locSyms = state.symbols.getLocation(loc.name);
      parts.push(loc.nameLower, locSyms ? locationInterface(locSyms) : '');
    }
    return parts.join('\n');
  }

  // ── File watcher handling ───────────────────────────────────────────

  /**
   * Apply a single file-watcher change to project state, without
   * rebuilding aggregates or re-diagnosing. Callers batch multiple
   * changes and rebuild once — see `handleWatchedFileChanges`.
   */
  private async applyFileChange(
    uri: string,
    changeType: number,
    fsProvider: FsProvider | undefined,
    fileEncoding: string,
  ): Promise<void> {
    if (changeType === FileChangeType.Deleted) {
      const label = uri.split('/').pop() ?? uri;
      this.log.log(`[QSP] File deleted: ${label}`);
      // File deleted — remove from project
      this.projectFileUris.delete(uri);
      if (!this.documents.get(uri)) {
        safeSendDiagnostics(this.connection, { uri, diagnostics: [] });
        this.documentStates.delete(uri);
      }
      return;
    }

    // Created or changed
    const label = uri.split('/').pop() ?? uri;
    this.log.log(`[QSP] File ${changeType === FileChangeType.Created ? 'created' : 'changed'}: ${label}`);
    this.projectFileUris.add(uri);

    const openDoc = this.documents.get(uri);
    if (!openDoc && fsProvider) {
      // File not open in editor — re-read from disk
      try {
        const filePath = fsProvider.uriToPath(uri);
        const text = await fsProvider.readFile(filePath, fileEncoding);
        this.analyzeFile(uri, text);
      } catch (e) {
        const filePath = uri.split('/').pop() ?? uri;
        this.log.error(`[QSP] Failed to read project file ${filePath}: ${e}`);
      }
    } else if (openDoc) {
      // File IS open in editor.  The watcher fires as soon as the file
      // is saved to disk, which may be BEFORE the 150 ms fast-tier
      // debounce has had a chance to call analyzeDocumentFast and
      // refresh documentStates.  If we call rebuildProjectAggregates()
      // below with the stale pre-debounce documentState, cross-file
      // duplicate detection will use the old locationIndex and report
      // false positives.  Refresh the locationIndex from the open
      // document's current content right now so the aggregate rebuild
      // is accurate.
      const text = stripBom(openDoc.getText());
      const locationIndex = buildLocationIndex(text);
      const prevState = this.documentStates.get(uri);
      if (prevState) {
        this.documentStates.set(uri, { ...prevState, locationIndex, suppressions: parseSuppressions(text, locationIndex) });
      }
    }
  }

  /**
   * Handle a batch of file-watcher changes (project mode).
   *
   * Applies every change first (re-reading changed/created files from
   * disk where needed) and rebuilds aggregates + re-diagnoses ONCE at
   * the end, rather than once per change. A single external event (e.g.
   * `git checkout` touching hundreds of files, or a workspace-wide
   * find-and-replace) would otherwise trigger one full project rebuild
   * per changed file.
   */
  async handleWatchedFileChanges(
    changes: readonly { uri: string; type: number }[],
    fsProvider: FsProvider | undefined,
    fileEncoding: string,
    diagnosticsSettings: DiagnosticSettings,
    collectCallTypes: () => Map<string, { name: string; types: Set<string> }>,
    collectPeerDocs: (ownUri: string) => DocumentSymbols[],
  ): Promise<void> {
    for (const change of changes) {
      await this.applyFileChange(change.uri, change.type, fsProvider, fileEncoding);
    }
    this.rebuildAndReanalyzeAll(diagnosticsSettings, collectCallTypes, collectPeerDocs, undefined, changes.map(c => c.uri));
  }
}
