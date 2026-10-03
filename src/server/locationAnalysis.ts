// ── Analysis of one location ─────────────────────────────────────────
//
// Files are parsed one location at a time, by the project scan and by the
// editor. Shared here so both get the same symbols.

import { LocationSymbols, extractErrors, extractSymbols, locationInterface, type SyntaxError } from '../parser';
import { extractLocationSymbolsFromText, mergeActionsFromText, mergeLabelsFromText } from './regexFallback';

/**
 * The symbols of a location parsed alone (`tree`, of `locText`), in its
 * own coordinates: its header is line 0. Where syntax errors hid actions
 * or labels from tree-sitter, they are added from the text; a location
 * tree-sitter didn't find at all gets them from the text only (`regexOnly`).
 */
export function extractLocationSymbols(
  tree: Parameters<typeof extractSymbols>[0],
  docUri: string,
  locationName: string,
  locText: string,
  embedParseFn: Parameters<typeof extractSymbols>[2],
): LocationSymbols {
  // extractSymbols wraps the location in a DocumentSymbols with one entry.
  let found: LocationSymbols | undefined;
  for (const [, ls] of extractSymbols(tree, docUri, embedParseFn).symbols.locations) {
    found = ls;
    break;
  }
  const lines = locText.split('\n').length;
  const wholeText = {
    name: locationName, nameLower: locationName.toLowerCase(),
    startLine: 0, endLine: lines - 1, startOffset: 0, endOffset: locText.length,
  };
  if (!found) {
    // E.g. the entire tree is ERROR: an empty location, so the result is still cached.
    const empty = new LocationSymbols(locationName);
    empty.hasErrors = true;
    extractLocationSymbolsFromText(locText, wholeText, empty, docUri);
    return empty;
  }
  if (found.hasErrors) {
    // ERROR nodes can swallow act blocks and labels; tree-sitter's own are
    // kept (more accurate for valid syntax), the text adds those on lines it missed.
    mergeActionsFromText(locText, wholeText, found, docUri);
    mergeLabelsFromText(locText, wholeText, found, docUri);
  }
  return found;
}

/**
 * The symbols and syntax errors of a location parsed alone (`tree`, of
 * `locText`), in its own coordinates. `step` times each part (PerfLog.step).
 */
export function analyzeParsedLocation(
  tree: Parameters<typeof extractSymbols>[0],
  docUri: string,
  locationName: string,
  locText: string,
  embedParseFn: Parameters<typeof extractSymbols>[2],
  step: <T>(name: string, fn: () => T) => T,
): { symbols: LocationSymbols; errors: SyntaxError[] } {
  const symbols = step('symbols', () => extractLocationSymbols(tree, docUri, locationName, locText, embedParseFn));
  // Made now, from the symbols as extracted, so deciding what an edit
  // changed for the other files costs nothing then.
  step('interface', () => locationInterface(symbols));
  return { symbols, errors: step('errors', () => extractErrors(tree)) };
}

const FOLDABLE_TYPES = ['act_block', 'if_block', 'loop_block'];

/** Start and end lines, in pairs, of the act, if and loop blocks of `tree` that span several lines. */
export function collectFoldLines(tree: Parameters<typeof extractSymbols>[0]): number[] {
  const lines: number[] = [];
  // Searched inside tree-sitter: walking every node from JS cost as much
  // as half the parse.
  for (const node of tree.rootNode.descendantsOfType(FOLDABLE_TYPES)) {
    const start = node.startPosition.row;
    const end = node.endPosition.row;
    if (end > start) lines.push(start, end);
  }
  return lines;
}
