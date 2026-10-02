/**
 * Diagnostic computation for QSP documents.
 *
 * Orchestrates domain-specific diagnostic passes.  Each domain module
 * is self-contained — it imports only the data it reasons about and
 * exports pure check functions that push into a shared `DiagnosticCtx`.
 *
 * No diagnostic pass mutates shared state beyond its own scope; the
 * orchestrator simply concatenates results.
 */


import type { TextDocument } from 'vscode-languageserver-textdocument';
import {
  type DocumentSymbols,
  type LocationEntry,
  type QspSymbol,
  type SyntaxError,
  type QspTreeSitterParser,
} from '../parser';
import {
  type SymbolAggregates,
  type ProjectAggregates,
  buildFileAggregates,
} from './aggregation';

// ── Diagnostic passes ─────────────────────────────────────────────────

import { libraryIdOfUri } from '../common/libraryConfig';
import type { Suppressions } from '../common/suppressions';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { DiagnosticCtx } from './diagnosticPasses/diagnosticHelpers';
import { checkSyntaxErrors, checkDuplicateLocations, checkLocationBounds } from './diagnosticPasses/structureDiagnostics';
import { checkLocationSymbols } from './diagnosticPasses/symbolDiagnostics';
import { checkVariables } from './diagnosticPasses/variableDiagnostics';
import { checkDynamicCalls } from './diagnosticPasses/dynamicDiagnostics';
import { checkPropagation } from './diagnosticPasses/propagationDiagnostics';

// ── Types (kept here — the public API entry point) ────────────────────

/** Diagnostic feature flags (mirrors QspSettings['diagnostics']). */
export interface DiagnosticSettings {
  duplicateLocations: boolean;
  duplicateLabels: boolean;
  duplicateActions: boolean;
  unreachableLabels: boolean;
  unclosedLocations: boolean;
  uninitializedVariables: boolean;
  unresolvedLocationRefs: boolean;
  unresolvedLabelRefs: boolean;
  unresolvedActionRefs: boolean;
  unresolvedObjectRefs: boolean;
  unusedLocations: boolean;
  unusedLabels: boolean;
  unusedVariables: boolean;
  unusedObjects: boolean;
  invalidFunctionPrefix: boolean;
  invalidBuiltinArgCount: boolean;
  deprecatedBuiltins: boolean;
  mixedVariablePrefixes: boolean;
  typeMismatch: boolean;
  mixedLocationCallTypes: boolean;
  inconsistentLocalPropagation: boolean;
  untrackedDynamicCalls: boolean;
  missingResultInFunctionCall: boolean;
  extraArgsToTargetWithoutArgs: boolean;
  shadowsCallFrameBuiltin: boolean;
  shadowsPropagatedLocal: boolean;
  maxErrorsPerLocation: number;
  maxLocationLines: number;
  /** At most this many diagnostics per file, the most severe first; 0 = all. */
  maxPerFile: number;
  /**
   * Not a user setting: lower-case URI prefixes of each workspace folder's
   * `libs/` (`libraryFolderPrefixes`), set by the server from its workspace
   * folders. Files there get errors only, and duplicates name the library.
   */
  libraryFolders?: readonly string[];
}

// ── Main entry point ──────────────────────────────────────────────────

/** Compute all diagnostics for a single document. */
export function computeDiagnostics(
  doc: TextDocument | null,
  docUri: string,
  locationIndex: LocationEntry[],
  diagnosticSettings: DiagnosticSettings,
  tsParser: QspTreeSitterParser,
  callTypesPerTarget: Map<string, { name: string; types: Set<string> }>,
  symbols?: DocumentSymbols,
  preExtractedErrors?: SyntaxError[],
  projectAgg?: ProjectAggregates | null,
  cachedFileAgg?: SymbolAggregates,
  projectDocs: DocumentSymbols[] = [],
  suppressions?: Suppressions,
): import('vscode-languageserver').Diagnostic[] {
  const libraryFolders = diagnosticSettings.libraryFolders ?? [];
  const libraryOf = (uri: string) => libraryIdOfUri(uri, libraryFolders);
  const ctx = new DiagnosticCtx(doc, diagnosticSettings, libraryOf(docUri) !== undefined, suppressions);

  // A mistyped `!@qsp-ignore` silences nothing, so say so where it is written.
  for (const p of suppressions?.problems ?? []) {
    ctx.push(
      DiagnosticSeverity.Warning,
      { start: { line: p.line, character: p.startCol }, end: { line: p.line, character: p.endCol } },
      p.message,
      { code: 'suppression' },
    );
  }

  // ── Document-structure diagnostics ──────────────────────────────
  checkSyntaxErrors(ctx, docUri, locationIndex, tsParser, preExtractedErrors, symbols);
  if (diagnosticSettings.duplicateLocations) {
    checkDuplicateLocations(ctx, locationIndex, docUri, projectAgg, libraryOf);
  }
  if (diagnosticSettings.unclosedLocations || diagnosticSettings.maxLocationLines > 0) {
    checkLocationBounds(ctx, locationIndex);
  }

  if (!symbols) return ctx.results();

  // ── Aggregates ──────────────────────────────────────────────────
  let agg: SymbolAggregates;
  let allLocationDefs: Map<string, QspSymbol>;

  if (projectAgg) {
    agg = projectAgg;
    allLocationDefs = projectAgg.flatLocationDefs;
  } else if (cachedFileAgg) {
    agg = cachedFileAgg;
    allLocationDefs = symbols.locationDefs;
  } else {
    agg = buildFileAggregates(symbols, docUri);
    allLocationDefs = symbols.locationDefs;
  }

  const { definedActions, definedObjects, referencedObjects } = agg;
  const isProject = !!projectAgg;

  // Tree shared by variable dataflow passes (fetched once).
  const tree = (tsParser.isReady ? tsParser.getTree(docUri) : null) ?? undefined;

  // ── Per-location: symbol def/ref diagnostics ────────────────────
  for (const [, locSyms] of symbols.locations) {
    if (locSyms.hasErrors) continue;
    checkLocationSymbols(
      ctx, locSyms, allLocationDefs,
      definedActions, definedObjects, referencedObjects,
      callTypesPerTarget, isProject, agg.hasRegexOnlyLocations,
    );
  }

  // ── Variable dataflow diagnostics ────────────────────────────────
  checkVariables(ctx, symbols, agg, docUri, tree, projectDocs);

  // ── Dynamic/dyneval call diagnostics ────────────────────────────
  checkDynamicCalls(ctx, symbols);

  // ── Cross-location propagation diagnostics ──────────────────────
  checkPropagation(
    ctx, symbols, agg, locationIndex, allLocationDefs,
    projectAgg?.firstLocationKey,
  );

  return ctx.results();
}
