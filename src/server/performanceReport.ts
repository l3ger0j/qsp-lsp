// ── Performance report ───────────────────────────────────────────────
//
// The shape of the analysed project in numbers: file and location sizes,
// how many symbols, references and bindings the analysis holds, how big
// the project aggregates are, and (when collected) how often each grammar
// construct occurs. Served as `qsp/performanceReport` and saved by
// "QSP: Collect Performance Profile". It never holds file, location,
// variable or object names, or any source text: users send it for games
// they can't share, and a synthetic game of the same shape
// (scripts/stress/genGame.mjs --shape) reproduces the problem.

import type { LocationEntry, LocationSymbols, QspSymbol, SymbolLocation, TreeStats } from '../parser';
import type { DocumentState } from './featureTypes';
import type { MemorySample } from './perfLog';

/** Sizes of a set of numbers. */
export interface Distribution {
  count: number;
  total: number;
  min: number;
  median: number;
  p90: number;
  p99: number;
  max: number;
}

export interface FileShape {
  chars: number;
  lines: number;
  locations: number;
  open: boolean;
  /** Parsed one location at a time (large files, or whole-file parse timed out). */
  perLocation: boolean;
  /** Per-location trees kept for incremental re-parsing (≥ 50 KB locations). */
  retainedTrees: number;
  /** Semantic tokens held in the per-location cache. */
  cachedTokens: number;
  syntaxErrors: number;
}

/** What the analysis holds for one location, or summed over all of them. */
export interface SymbolCounts {
  variables: number;
  variableRefs: number;
  locationRefTargets: number;
  locationRefSites: number;
  objectRefSites: number;
  actionRefSites: number;
  actions: number;
  labels: number;
  bindingVariables: number;
  bindings: number;
  /** Entries in the `localsInScope` snapshots taken at call sites. */
  localsInScopeEntries: number;
  localNames: number;
  dynamicLocationRefs: number;
  dynamicVarCalls: number;
  resolvedDynamicBlocks: number;
}

export interface PerformanceReport {
  server: { parser: string; projectMode: boolean; embeddedExec: boolean; uptimeSeconds: number };
  memory?: MemorySample;
  /** Largest first; the order and sizes don't reveal names. */
  files: FileShape[];
  locations: { chars: Distribution; lines: Distribution };
  symbols: SymbolCounts;
  /** The ten locations holding the most analysis data, as counts. */
  heaviestLocations: Array<SymbolCounts & { chars: number }>;
  globalBindings: { variables: number; entries: number };
  /** Size of each collection in the project aggregates (field name → entries). */
  aggregates: Record<string, number>;
  /** A file whose analysis was still running (the one a crash interrupts). */
  inProgress?: { chars: number; locations: number; parsedLocations: number };
  /** Grammar constructs, when the profiler collected them. */
  nodeTypes?: { maxDepth: number; types: Record<string, { count: number; chars: number; maxChars: number }> };
}

export interface ReportInput {
  states: ReadonlyMap<string, DocumentState>;
  openUris: ReadonlySet<string>;
  parser: string;
  projectMode: boolean;
  embeddedExec: boolean;
  uptimeSeconds: number;
  memory?: MemorySample;
  aggregates?: object | null;
  treeStats?: TreeStats;
  /** A file analysis still running: its location index and the constructs counted so far. */
  inProgress?: { locationIndex: readonly LocationEntry[]; parsedLocations: number };
}

/** Summarise `values` (need not be sorted). */
export function distribution(values: number[]): Distribution {
  if (values.length === 0) return { count: 0, total: 0, min: 0, median: 0, p90: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    count: sorted.length,
    total: sorted.reduce((s, v) => s + v, 0),
    min: sorted[0],
    median: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
  };
}

function emptyCounts(): SymbolCounts {
  return {
    variables: 0, variableRefs: 0, locationRefTargets: 0, locationRefSites: 0, objectRefSites: 0, actionRefSites: 0,
    actions: 0, labels: 0, bindingVariables: 0, bindings: 0, localsInScopeEntries: 0, localNames: 0,
    dynamicLocationRefs: 0, dynamicVarCalls: 0, resolvedDynamicBlocks: 0,
  };
}

function addCounts(into: SymbolCounts, from: SymbolCounts): void {
  for (const k of Object.keys(into) as (keyof SymbolCounts)[]) into[k] += from[k];
}

function localsIn(locs: Iterable<SymbolLocation>): number {
  let n = 0;
  for (const l of locs) n += l.localsInScope?.size ?? 0;
  return n;
}

function sites(symbols: Iterable<QspSymbol>): { sites: number; locals: number } {
  let count = 0, locals = 0;
  for (const s of symbols) {
    count += s.references.length;
    locals += localsIn(s.references);
  }
  return { sites: count, locals };
}

/** What `ls` holds, as counts. */
export function countLocationSymbols(ls: LocationSymbols): SymbolCounts {
  const c = emptyCounts();
  const vars = sites(ls.variables.values());
  const locRefs = sites(ls.locationRefs.values());
  const objRefs = sites(ls.objectRefs.values());
  const actRefs = sites(ls.actionRefs.values());
  c.variables = ls.variables.size;
  c.variableRefs = vars.sites;
  c.locationRefTargets = ls.locationRefs.size;
  c.locationRefSites = locRefs.sites;
  c.objectRefSites = objRefs.sites;
  c.actionRefSites = actRefs.sites;
  c.actions = ls.actions.length;
  for (const scope of ls.labels.values()) c.labels += scope.size;
  c.bindingVariables = ls.variableBindings.size;
  for (const list of ls.variableBindings.values()) c.bindings += list.length;
  c.localsInScopeEntries = vars.locals + locRefs.locals + objRefs.locals + actRefs.locals;
  c.localNames = ls.localNames.size;
  c.dynamicLocationRefs = ls.dynamicLocationRefs.length;
  c.dynamicVarCalls = ls.dynamicVarCalls.length + ls.untrackedDynamicVarCalls.length
    + ls.unresolvedDynamicVarCalls.length + ls.deferredDynamicVarCalls.length;
  c.resolvedDynamicBlocks = ls.resolvedDynamicBlocks.length;
  return c;
}

function collectionSize(v: unknown): number | undefined {
  if (v instanceof Map || v instanceof Set) return v.size;
  if (Array.isArray(v)) return v.length;
  return undefined;
}

/** Build the report. Pure: everything it needs comes in `input`. */
export function buildPerformanceReport(input: ReportInput): PerformanceReport {
  const files: FileShape[] = [];
  const locChars: number[] = [];
  const locLines: number[] = [];
  const symbols = emptyCounts();
  const heaviest: Array<SymbolCounts & { chars: number }> = [];
  let globalVars = 0, globalEntries = 0;

  for (const [uri, state] of input.states) {
    let chars = 0, retainedTrees = 0, cachedTokens = 0;
    let lines = 0;
    for (const loc of state.locationIndex) {
      const size = loc.endOffset - loc.startOffset;
      chars += size;
      locChars.push(size);
      locLines.push(loc.endLine - loc.startLine + 1);
      lines = Math.max(lines, loc.endLine + 1);
    }
    if (state.perLocationCache) {
      for (const entry of state.perLocationCache.values()) {
        if (entry.tree) retainedTrees++;
        cachedTokens += Math.floor(entry.tokens.length / 5);
      }
    }
    files.push({
      chars, lines, locations: state.locationIndex.length, open: input.openUris.has(uri),
      perLocation: state.perLocationCache !== undefined, retainedTrees, cachedTokens,
      syntaxErrors: state.syntaxErrors?.length ?? 0,
    });

    const sizes = new Map(state.locationIndex.map(l => [l.nameLower, l.endOffset - l.startOffset]));
    for (const [key, ls] of state.symbols.locations) {
      const c = countLocationSymbols(ls);
      addCounts(symbols, c);
      heaviest.push({ ...c, chars: sizes.get(key) ?? 0 });
    }
    globalVars += state.symbols.globalBindings.size;
    for (const list of state.symbols.globalBindings.values()) globalEntries += list.length;
  }

  // The file being analysed isn't in `states` yet; its sizes still belong
  // in the distributions a synthetic game is generated from.
  if (input.inProgress) {
    for (const loc of input.inProgress.locationIndex) {
      locChars.push(loc.endOffset - loc.startOffset);
      locLines.push(loc.endLine - loc.startLine + 1);
    }
  }

  const weight = (c: SymbolCounts) => c.variableRefs + c.locationRefSites + c.bindings + c.localsInScopeEntries;
  heaviest.sort((a, b) => weight(b) - weight(a));
  files.sort((a, b) => b.chars - a.chars);

  const aggregates: Record<string, number> = {};
  if (input.aggregates) {
    for (const [field, value] of Object.entries(input.aggregates)) {
      const size = collectionSize(value);
      if (size !== undefined) aggregates[field] = size;
    }
  }

  const report: PerformanceReport = {
    server: { parser: input.parser, projectMode: input.projectMode, embeddedExec: input.embeddedExec, uptimeSeconds: Math.round(input.uptimeSeconds) },
    memory: input.memory,
    files,
    locations: { chars: distribution(locChars), lines: distribution(locLines) },
    symbols,
    heaviestLocations: heaviest.slice(0, 10),
    globalBindings: { variables: globalVars, entries: globalEntries },
    aggregates,
  };
  if (input.inProgress) {
    const idx = input.inProgress.locationIndex;
    report.inProgress = {
      chars: idx.reduce((n, l) => n + l.endOffset - l.startOffset, 0),
      locations: idx.length,
      parsedLocations: input.inProgress.parsedLocations,
    };
  }
  if (input.treeStats) {
    const types: Record<string, { count: number; chars: number; maxChars: number }> = {};
    for (const [type, c] of [...input.treeStats.types].sort((a, b) => b[1].count - a[1].count)) types[type] = { ...c };
    report.nodeTypes = { maxDepth: input.treeStats.maxDepth, types };
  }
  return report;
}
