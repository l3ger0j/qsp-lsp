/**
 * Types shared across the LSP feature handler modules.
 *
 * Centralizes interface definitions so individual feature modules
 * can import what they need without circular dependencies.
 */
import type {
  SemanticTokens,
} from 'vscode-languageserver';
import type Parser from 'web-tree-sitter';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Suppressions } from '../common/suppressions';
import type {
  DocumentSymbols,
  LocationSymbols,
  LocationEntry,
  QspTreeSitterParser,
  PossibleValueEntry,
  SyntaxError,
} from '../parser';
import type {
  SymbolAggregates,
  ProjectAggregates,
} from './aggregation';

// ──────────────────────────────────────────────────────────────────────
// Per-location cache
// ──────────────────────────────────────────────────────────────────────

/** Per-location parse cache entry (only for large files). */
export interface PerLocationParseResult {
  text: string;
  /**
   * The location's symbols, with line numbers counted from `symbolsLine`:
   * 0 as parsed, the location's start line once placed in a document.
   * The cache and the document share them, so a large file keeps one copy.
   */
  symbols: LocationSymbols;
  symbolsLine: number;
  /** In the location's own coordinates (its header is line 0), like `tokens`. */
  errors: SyntaxError[];
  /**
   * Semantic token tuples [line, char, length, type, modifiers, …],
   * packed: a large file holds millions of them, and a plain array of
   * numbers takes twice the memory.
   */
  tokens: Uint32Array;
  hasErrors: boolean;
  tree?: Parser.Tree;
}

// ──────────────────────────────────────────────────────────────────────
// Document state
// ──────────────────────────────────────────────────────────────────────

/** State for a single open document. */
export interface DocumentState {
  locationIndex: LocationEntry[];
  symbols: DocumentSymbols;
  cachedSemanticTokens?: { data: number[] };
  perLocationCache?: Map<string, PerLocationParseResult>;
  rawText?: string;
  /** Cached single-file aggregates (invalidated when the state object is replaced). */
  aggCache?: SymbolAggregates;
  /** Cached call-types-per-target for THIS document. Lazily built. */
  cachedCallTypes?: Map<string, { name: string; types: Set<string> }>;
  /**
   * True when the symbol positions (line/column) may be approximate
   * because the symbols were reused from a previous parse cycle
   * during the fast tier.
   */
  positionsApproximate?: boolean;
  /**
   * Syntax errors of a file that has no whole-file tree to read them from:
   * a project file not open in the editor (its tree is freed right after
   * the scan), or an open file parsed location by location.
   */
  syntaxErrors?: SyntaxError[];
  /** The file's `!@qsp-ignore` comments, read from the text this state was built from. */
  suppressions?: Suppressions;
}

// ──────────────────────────────────────────────────────────────────────
// Settings + server context
// ──────────────────────────────────────────────────────────────────────

/** Settings shape the feature handlers need. */
export interface FeatureSettings {
  project: { enabled: boolean };
  embeddedExec: { enabled: boolean };
  semanticHighlighting: { enabled: boolean };
  hover: { possibleValues: boolean; maxItemsPerCategory: number };
}

/**
 * Shared server context — provides access to all mutable state and
 * helpers that the LSP feature handlers need.
 */
export interface ServerContext {
  connection: import('vscode-languageserver').Connection;
  documents: import('vscode-languageserver').TextDocuments<TextDocument>;
  documentStates: Map<string, DocumentState>;
  settings: FeatureSettings;
  projectAggregates: ProjectAggregates | null;
  projectFileUris: Set<string>;
  tsParser: QspTreeSitterParser;
  collectCallTypesPerTarget(): Map<string, { name: string; types: Set<string> }>;
  buildTokensFromCache(
    locationIndex: LocationEntry[],
    cache: Map<string, PerLocationParseResult>,
    gotoTargets?: ReadonlySet<string>,
  ): SemanticTokens;
}

// ──────────────────────────────────────────────────────────────────────
// Hover option types
// ──────────────────────────────────────────────────────────────────────

/** Options for `buildPossibleValuesLines`. */
export interface BuildPossibleValuesOptions {
  /**
   * Optional resolver for var-ref chain targets.  Given a lowercased
   * canonical key (e.g. `$g`), returns document/project-wide terminal
   * writes for that key.  When provided, var-ref entries are flattened
   * into one line per chain-target write.
   */
  expandVarRef?: (targetVarName: string) => readonly PossibleValueEntry[];
  /**
   * Override the default per-category cap (`DEFAULT_HOVER_MAX_ITEMS`).
   * Applied both to the number of distinct values and to the inline
   * location citations per value.
   */
  maxItems?: number;
}

// ──────────────────────────────────────────────────────────────────────
// Variable list item
// ──────────────────────────────────────────────────────────────────────

/** Variable entry returned by `collectProjectVariables`. */
export interface ProjectVariableItem {
  name: string;
  uri: string;
  line: number;
  isDefined: boolean;
  isLocal: boolean;
  prefixes: string[];
}
