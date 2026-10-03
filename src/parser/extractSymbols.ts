/**
 * Symbol extraction from tree-sitter parse trees.
 *
 * Walks location blocks and populates a DocumentSymbols table with
 * variables, labels, actions, location references, object references,
 * and action references.
 *
 * This module is the public-facing orchestrator.  Detailed work is
 * delegated to:
 *   - walkHelpers.ts      — shared types, constants, arg/string utilities
 *   - lookupTables.ts     — statement/function name classification sets
 *   - variableUtils.ts    — variable definition/classification helpers
 *   - symbolExtractors.ts — per-node extractors (variables, labels, …)
 *   - bindingCollector.ts — assignment pre-scan + dynamic call resolution
 *   - symbolWalker.ts     — main recursive AST walker + deferred blocks
 */


import type Parser from 'web-tree-sitter';
import { DocumentSymbols, type LocationSymbols } from './symbolTable';
import { nodeLoc } from './walkHelpers';
import { hasStructuralErrors } from './extractErrors';
import { walkLocationBody } from './symbolWalker';
import { extractEmbeddedExec } from './embeddedExec';
import { extractEmbeddedInterpolations } from './embeddedInterpolation';
import { scopePathOf } from './scopeUtils';

// Re-export for backward compatibility.
export { isVariableDefinition } from './variableUtils';
export { extractQuotedRefInfo, extractExactQuotedRefInfo, nodeLoc } from './walkHelpers';

// ──────────────────────────────────────────────────────────────────────

/**
 * Walk the parse tree and populate a DocumentSymbols table.
 *
 * When `parseFn` is provided, every location is also scanned for
 * embedded `<a href="exec:CODE">` hyperlinks; their bodies are
 * sub-parsed via `parseFn` and contributed location / object / action
 * refs are merged into the host location's symbols.
 */
export function extractSymbols(
  tree: Parser.Tree,
  docUri: string,
  parseFn?: (text: string) => Parser.Tree | null,
): { symbols: DocumentSymbols } {
  const symbols = new DocumentSymbols(docUri);
  const root = tree.rootNode;

  const findNamedChild = (
    node: Parser.SyntaxNode,
    type: string,
  ): Parser.SyntaxNode | undefined => {
    const n = node.namedChildCount;
    for (let i = 0; i < n; i++) {
      const c = node.namedChild(i);
      if (c && c.type === type) return c;
    }
    return undefined;
  };

  const walked: Array<[Parser.SyntaxNode, LocationSymbols]> = [];
  const rootChildCount = root.namedChildCount;
  for (let i = 0; i < rootChildCount; i++) {
    const locBlock = root.namedChild(i);
    if (!locBlock || locBlock.type !== 'location_block') continue;

    const header = locBlock.childForFieldName('location_header')
      ?? findNamedChild(locBlock, 'location_header');
    if (!header) continue;

    const nameNode = findNamedChild(header, 'location_name');
    if (!nameNode) continue;

    const locName = nameNode.text.trim();
    const locLoc = nodeLoc(nameNode, docUri);

    const locSymbols = symbols.addLocation(locName, locLoc);
    locSymbols.hasErrors = hasStructuralErrors(locBlock);
    walkLocationBody(locBlock, locSymbols, docUri);
    walked.push([locBlock, locSymbols]);
  }

  extractEmbeddedExec(tree, docUri, symbols, parseFn);
  extractEmbeddedInterpolations(tree, docUri, symbols, parseFn);
  // After the embedded passes, whose references sit in the host's strings.
  for (const [locBlock, locSymbols] of walked) recordCheckScopes(locBlock, locSymbols);

  symbols.rebuildGlobalBindings();
  return { symbols };
}

// The scopes of the references the variable checks start from: a
// variable's first reference and its first read. The checks then need no
// tree, so a file gets the same warnings open or closed, parsed whole or
// location by location, or read from the analysis cache.
function recordCheckScopes(locBlock: Parser.SyntaxNode, locSymbols: LocationSymbols): void {
  for (const sym of locSymbols.ownedVariables) {
    const first = sym.references[0];
    const firstRead = sym.references.find(r => r.isProperUsage);
    for (const ref of [first, firstRead]) {
      if (!ref || ref.scopePath) continue;
      // Copied to its length: the pushed array keeps room to grow, 13 MB
      // in all on a 12.8 M-character file.
      ref.scopePath = scopePathOf(locBlock.descendantForPosition({ row: ref.line, column: ref.column }), locBlock).slice();
    }
  }
}
