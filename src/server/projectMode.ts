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
import type { TextDocument } from 'vscode-languageserver-textdocument';
import {
  buildLocationIndex,
  DocumentSymbols,
  LocationSymbols,
  extractSymbols,
  fullParseTimeoutMicros,
  QspSymbolKind,
  type QspSymbol,
  type SymbolLocation,
  type LocationEntry,
  type QspTreeSitterParser,
} from '../parser';
import {
  buildRegexSymbols,
  extractLocationSymbolsFromText,
} from './regexFallback';
import {
  type ProjectAggregates,
  collectAggregates,
  buildPropagatedLocals,
  emptyAggregates,
} from './aggregation';
import type { DiagnosticSettings } from './diagnostics';
import type { DocumentState } from './lspFeatures';
import { computeDiagnostics } from './diagnostics';
import { stripBom, makeLocSymLoc, QSP_FILE_EXTENSIONS, safeSendDiagnostics, type FsProvider } from './serverUtils';

/**
 * Files at or above this size are parsed per-location instead of as one
 * whole-document tree-sitter tree. Mirrors `PER_LOCATION_BYTE_THRESHOLD`
 * in common.ts (kept as a separate constant because project-mode files
 * don't need the incremental-retained-tree machinery that threshold also
 * gates there — project files aren't edited in place). A single
 * `parseOnce()` call on a multi-MB file can still take seconds even
 * though it's individually timeout-bounded; splitting by location keeps
 * each parse in the low-single-digit-millisecond range, the same reason
 * common.ts avoids one huge tree for large open documents.
 */
const PROJECT_PER_LOCATION_BYTE_THRESHOLD = 500_000; // 500 KB

/** Yield to the event loop between files during a bulk scan, so pending
 *  LSP requests (hover, completion, …) get a turn instead of queuing
 *  behind a long run of synchronous parses. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ──────────────────────────────────────────────────────────────────────

export class ProjectModeService {
  /** Workspace root folders (populated on initialize). */
  workspaceFolders: string[] = [];

  /** Cached project aggregates (null when project mode is off). */
  projectAggregates: ProjectAggregates | null = null;

  /** URIs of all project files (both open and on-disk). */
  readonly projectFileUris = new Set<string>();

  /**
   * Whether to sub-parse `<a href="exec:...">` link bodies during
   * symbol extraction. Mirrored from `qsp.embeddedExec.enabled`; the
   * server updates this on configuration change.
   */
  embeddedExecEnabled = true;

  constructor(
    private connection: Connection,
    private documents: TextDocuments<TextDocument>,
    private documentStates: Map<string, DocumentState>,
    private tsParser: QspTreeSitterParser,
  ) {}

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
    fsProvider: FsProvider,
    fileEncoding: string,
    collectCallTypes: () => Map<string, { name: string; types: Set<string> }>,
    collectPeerDocs: (ownUri: string) => DocumentSymbols[],
    diagnosticsSettings: DiagnosticSettings,
  ): Promise<void> {
    this.connection.console.log('[QSP] Initializing project mode...');
    this.projectFileUris.clear();

    // Discover all QSP files in workspace folders. `findFiles` already
    // yields between directories; this counter adds an extra yield every
    // few files so a single directory holding thousands of files can't
    // monopolize the event loop between those directory-level yields.
    let processedSinceYield = 0;
    for (const folder of this.workspaceFolders) {
      for await (const filePath of fsProvider.findFiles(folder, QSP_FILE_EXTENSIONS)) {
        const uri = fsProvider.pathToUri(filePath);
        this.projectFileUris.add(uri);

        // If not already open in editor, read from disk and analyze
        if (!this.documents.get(uri)) {
          try {
            const text = await fsProvider.readFile(filePath, fileEncoding);
            this.analyzeFile(uri, text);
          } catch (e) {
            this.connection.console.error(`[QSP] Failed to read project file ${filePath}: ${e}`);
          }
        }

        if (++processedSinceYield >= 20) {
          processedSinceYield = 0;
          await yieldToEventLoop();
        }
      }
    }

    // Also add all currently open documents
    for (const doc of this.documents.all()) {
      this.projectFileUris.add(doc.uri);
    }

    // Build aggregates and re-diagnose everything
    this.rebuildAndReanalyzeAll(diagnosticsSettings, collectCallTypes, collectPeerDocs);

    this.connection.console.log(
      `[QSP] Project mode initialized with ${this.projectFileUris.size} files`,
    );
  }

  /** Tear down project mode: clear non-open file states, clear aggregates. */
  teardown(): void {
    this.connection.console.log('[QSP] Tearing down project mode');

    // Clear diagnostics for non-open files
    for (const uri of this.projectFileUris) {
      if (!this.documents.get(uri)) {
        safeSendDiagnostics(this.connection, { uri, diagnostics: [] });
        this.documentStates.delete(uri);
      }
    }

    this.projectFileUris.clear();
    this.projectAggregates = null;
  }

  /**
   * Analyze a project file that isn't open in the editor.
   * Creates a DocumentState from the raw text.
   */
  analyzeFile(uri: string, text: string): void {
    const locationIndex = buildLocationIndex(text);
    let symbols: DocumentSymbols;

    if (!this.tsParser.isReady) {
      symbols = buildRegexSymbols(uri, locationIndex, text);
    } else if (text.length >= PROJECT_PER_LOCATION_BYTE_THRESHOLD) {
      symbols = this.analyzePerLocation(uri, text, locationIndex);
    } else {
      const tree = this.tsParser.parseOnce(text, fullParseTimeoutMicros(text.length));
      if (tree) {
        const result = extractSymbols(
          tree, uri, undefined, undefined,
          this.embeddedExecEnabled ? (t) => this.tsParser.parseOnce(t) : undefined,
        );
        symbols = result.symbols;
        tree.delete();
      } else {
        symbols = this.analyzePerLocation(uri, text, locationIndex);
      }
    }

    this.documentStates.set(uri, {
      locationIndex,
      symbols,
      cachedSemanticTokens: undefined,
    });
  }

  // Large project files, and files whose whole-file parse timed out, are
  // parsed one location at a time. See PROJECT_PER_LOCATION_BYTE_THRESHOLD.
  private analyzePerLocation(uri: string, text: string, locationIndex: LocationEntry[]): DocumentSymbols {
    const symbols = new DocumentSymbols(uri);
    for (const loc of locationIndex) {
      const locText = text.slice(loc.startOffset, loc.endOffset);
      const locLoc = makeLocSymLoc(uri, text, loc);
      const tree = this.tsParser.parseOnce(locText);
      if (tree) {
        const result = extractSymbols(
          tree, uri, undefined, undefined,
          this.embeddedExecEnabled ? (t) => this.tsParser.parseOnce(t) : undefined,
        );
        // extractSymbols wraps the location in a DocumentSymbols with
        // one entry — pull out its LocationSymbols (same pattern as
        // common.ts's parseLocationBlock).
        let locSymbols: LocationSymbols | undefined;
        for (const [, ls] of result.symbols.locations) { locSymbols = ls; break; }
        if (locSymbols) {
          symbols.addLocationFrom(loc.name, locLoc, locSymbols, loc.startLine);
        } else {
          const empty = symbols.addLocation(loc.name, locLoc);
          empty.hasErrors = true;
        }
        tree.delete();
      } else {
        // Tree-sitter failed (timeout) for this one location — fall
        // back to regex extraction for just that location.
        const locSymbols = symbols.addLocation(loc.name, locLoc);
        extractLocationSymbolsFromText(text, loc, locSymbols, uri);
      }
    }
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
      buildPropagatedLocals(allLocs, agg);
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

  // ── Diagnostics ─────────────────────────────────────────────────────

  /**
   * Re-diagnose all project files using the current project aggregates.
   */
  reanalyzeAll(
    diagnosticsSettings: DiagnosticSettings,
    collectCallTypes: () => Map<string, { name: string; types: Set<string> }>,
    collectPeerDocs: (ownUri: string) => DocumentSymbols[],
    getDoc: (uri: string) => TextDocument | undefined,
  ): void {
    if (!this.projectAggregates) return;

    const callTypes = this.projectAggregates.callTypesPerTarget ?? collectCallTypes();

    for (const uri of this.projectFileUris) {
      const state = this.documentStates.get(uri);
      if (!state) continue;

      const doc = getDoc(uri);
      const diagnostics = computeDiagnostics(
        doc ?? null,
        uri,
        state.locationIndex,
        diagnosticsSettings,
        this.tsParser,
        callTypes,
        state.symbols,
        undefined,
        this.projectAggregates,
        undefined,
        collectPeerDocs(uri),
      );
      safeSendDiagnostics(this.connection, { uri, diagnostics });
    }
  }

  /** Convenience: rebuild aggregates then re-diagnose everything. */
  rebuildAndReanalyzeAll(
    diagnosticsSettings: DiagnosticSettings,
    collectCallTypes: () => Map<string, { name: string; types: Set<string> }>,
    collectPeerDocs: (ownUri: string) => DocumentSymbols[],
  ): void {
    this.rebuildAggregates(collectCallTypes);
    this.reanalyzeAll(
      diagnosticsSettings, collectCallTypes, collectPeerDocs,
      uri => this.documents.get(uri),
    );
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
      this.connection.console.log(`[QSP] File deleted: ${label}`);
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
    this.connection.console.log(`[QSP] File ${changeType === FileChangeType.Created ? 'created' : 'changed'}: ${label}`);
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
        this.connection.console.error(`[QSP] Failed to read project file ${filePath}: ${e}`);
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
        this.documentStates.set(uri, { ...prevState, locationIndex });
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
    this.rebuildAndReanalyzeAll(diagnosticsSettings, collectCallTypes, collectPeerDocs);
  }
}
