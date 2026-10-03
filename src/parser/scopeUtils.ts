/**
 * Scope and binding-visibility helpers for tree-sitter ASTs.
 *
 * These functions walk the tree-sitter parent chain to determine
 * lexical scope boundaries and whether a variable binding (definition)
 * is visible from a given consumer node.
 *
 * They are shared between the pre-walk (collectVariableBindings) and
 * the main walker in extractSymbols, and are also used directly by
 * variableBindings.ts for binding resolution.
 */


import type Parser from 'web-tree-sitter';

// ──────────────────────────────────────────────────────────────────────
// Local helpers — duplicates of items in extractSymbols.ts to keep this
// module self-contained and avoid circular imports.
// ──────────────────────────────────────────────────────────────────────

/** Statement names that dynamically evaluate code. */
const DYNAMIC_STMT_NAMES = new Set(['dynamic']);

/** Functions that dynamically evaluate code. */
const DYNAMIC_FUNC_NAMES = new Set(['dyneval']);

/** AST node types that can be direct containers of a function call or statement. */
const CONTAINER_NODE_TYPES = new Set([
  'statement',
  'na_func_call', 'ext_func_call', 'ml_func_call',
  'na_unary', 'ext_unary', 'ml_unary',
]);

/** AST child types that represent metadata rather than arguments. */
const META_CHILD_TYPES = new Set([
  'statement_name', 'function_name', 'type_prefix',
  'op_obj', 'op_loc', 'op_no', 'op_neg', 'op_pos',
]);

/** Get the first non-meta argument of a statement or function call. */
function getFirstArgNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const cn = node.childCount;
  for (let i = 0; i < cn; i++) {
    const c = node.child(i);
    if (c && c.type === 'paren_args') return c.namedChild(0);
  }
  const nn = node.namedChildCount;
  for (let i = 0; i < nn; i++) {
    const c = node.namedChild(i);
    if (c && !META_CHILD_TYPES.has(c.type)) return c;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Scope classification
// ──────────────────────────────────────────────────────────────────────

/**
 * Node types that open a new lexical scope.  Note that `code_block` is
 * scope-forming only when it's not consumed as a string argument —
 * callers must filter consumed blocks out before calling this helper.
 */
export function isScopeForming(nodeType: string): boolean {
  switch (nodeType) {
    case 'act_block':
    case 'act_inline':
    case 'loop_block':
    case 'loop_inline':
    case 'if_block':
    case 'if_inline':
    case 'else_clause':
    case 'elseif_clause':
    case 'else_inline':
    case 'elseif_inline':
    case 'code_block':
      return true;
    default:
      return false;
  }
}

/**
 * Returns true for else/elseif branch nodes.  When `isBindingVisible`
 * walks up and crosses one of these, bindings whose `bindScopeKey` is the
 * enclosing if_block (i.e. bindings in the *if-body*, not the else/elseif)
 * are NOT visible — they belong to a sibling branch, not the current one.
 */
export function isBranchNode(nodeType: string): boolean {
  switch (nodeType) {
    case 'else_clause':
    case 'elseif_clause':
    case 'else_inline':
    case 'elseif_inline':
      return true;
    default:
      return false;
  }
}

/**
 * Isolating scope boundaries — parent locals do NOT propagate across
 * them, and bindings inside them are NOT visible to consumers outside.
 *
 * `code_block` is isolating EXCEPT when it's the direct argument of a
 * `dynamic` / `dyneval` call, in which case it inherits the caller's
 * scope.  `isDynamicArgCodeBlock(node)` makes that determination.
 */
export function isIsolatingScope(nodeType: string): boolean {
  switch (nodeType) {
    case 'act_block':
    case 'act_inline':
    case 'code_block':
      return true;
    default:
      return false;
  }
}

/**
 * Return true when `node` is a `code_block` that appears as the direct
 * first argument of a `dynamic` / `dyneval` call — such blocks inherit
 * the caller's scope (non-isolating).
 */
export function isDynamicArgCodeBlock(node: Parser.SyntaxNode): boolean {
  if (node.type !== 'code_block') return false;
  // The container may be the direct parent (e.g. `dynamic { … }`) or
  // the grandparent when the call uses parentheses (e.g.
  // `dyneval({ … })`, where the parent is `paren_args`).
  let container = node.parent;
  if (!container) return false;
  if (container.type === 'paren_args') container = container.parent;
  if (!container) return false;
  if (!CONTAINER_NODE_TYPES.has(container.type)) return false;
  const nameNode = container.childForFieldName('name');
  const stmtName = nameNode?.text.toLowerCase() ?? '';
  if (!DYNAMIC_STMT_NAMES.has(stmtName) && !DYNAMIC_FUNC_NAMES.has(stmtName)) return false;
  // The first-arg must be this code_block itself (direct literal).
  const firstArg = getFirstArgNode(container);
  return firstArg?.id === node.id;
}

// ──────────────────────────────────────────────────────────────────────
// Scope ancestor walkers
// ──────────────────────────────────────────────────────────────────────

/**
 * Walk from `node` upward, returning the nearest ancestor whose type
 * is scope-forming AND not a consumed/deferred code block.  Returns
 * `null` when no such ancestor exists within `stopAt`.
 *
 * `isConsumed(nodeId)` — return true to skip a code_block that should
 * not count as a scope (e.g. consumed as a string arg, or not walked).
 */
export function findScopeAncestor(
  node: Parser.SyntaxNode,
  stopAt: Parser.SyntaxNode,
  isConsumed: (id: number) => boolean,
): Parser.SyntaxNode | null {
  let a: Parser.SyntaxNode | null = node.parent;
  while (a && a.id !== stopAt.id) {
    if (isScopeForming(a.type)) {
      if (a.type === 'code_block' && isConsumed(a.id)) {
        a = a.parent;
        continue;
      }
      return a;
    }
    a = a.parent;
  }
  return null;
}

/**
 * Walk from `node` upward, returning the nearest isolating-scope
 * ancestor (act_*, non-dynamic code_block).  Returns `null` when no
 * such ancestor exists within `stopAt`.
 */
export function findIsolationAncestor(
  node: Parser.SyntaxNode,
  stopAt: Parser.SyntaxNode,
  isConsumed: (id: number) => boolean,
): Parser.SyntaxNode | null {
  let a: Parser.SyntaxNode | null = node.parent;
  while (a && a.id !== stopAt.id) {
    if (isIsolatingScope(a.type)) {
      if (a.type === 'code_block') {
        if (isConsumed(a.id)) { a = a.parent; continue; }
        if (isDynamicArgCodeBlock(a)) { a = a.parent; continue; }
      }
      return a;
    }
    a = a.parent;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Binding visibility
// ──────────────────────────────────────────────────────────────────────

/**
 * A scope node's key: its offset from the start of `locBlock`, its
 * location, and its length. Bindings keep it instead of the node's id, an
 * address that means nothing in another parse: hover parses a location
 * again, and symbols outlive their tree (the analysis cache, a project
 * file's analysis reused when it opens). Never 0, which means the
 * location's top level.
 */
export function scopeKeyOf(node: Parser.SyntaxNode, locBlock: Parser.SyntaxNode): number {
  const start = node.startIndex;
  return (start - locBlock.startIndex + 1) * 2 ** 26 + (node.endIndex - start);
}

/**
 * The scopes around a point of a location, innermost first, as
 * {@link isBindingVisible} needs them: for each scope-forming ancestor,
 * its key ({@link scopeKeyOf}), its flags, and for an else/elseif branch
 * the key of its if_block. Plain numbers, no nodes: symbols keep it for
 * the reads the variable checks start from, so those need no tree.
 */
export type ScopePath = readonly number[];

const ISOLATING = 1;
const BRANCH = 2;
const STEP = 3;

/** The scope path of `node`, inside `locBlock` (its location_block). */
export function scopePathOf(node: Parser.SyntaxNode, locBlock: Parser.SyntaxNode): number[] {
  const path: number[] = [];
  for (let a = node.parent; a && a.id !== locBlock.id; a = a.parent) {
    if (!isScopeForming(a.type)) continue;
    let flags = 0;
    let branchOf = 0;
    if (isBranchNode(a.type) && a.parent) {
      flags |= BRANCH;
      branchOf = scopeKeyOf(a.parent, locBlock);
    }
    // A code block that is `dynamic`'s or `dyneval`'s own argument runs
    // in the caller's scope.
    if (isIsolatingScope(a.type) && !isDynamicArgCodeBlock(a)) flags |= ISOLATING;
    path.push(scopeKeyOf(a, locBlock), flags, branchOf);
  }
  return path;
}

/**
 * Whether a binding with scope `bindScopeKey`, isolation scope
 * `bindIsolKey` (see {@link scopeKeyOf}) and `bindIsLocal` is visible
 * at the point `path` describes.
 *
 * Visibility rules:
 *   • Global (non-local) bindings are visible EVERYWHERE — QSP stores
 *     them in a single flat namespace; isolation boundaries only
 *     affect `local` bindings.
 *   • For local bindings, going outward from the point:
 *     – reaching `bindScopeKey` makes it visible, unless that is the
 *       if_block whose if-body we may not see from an else/elseif branch;
 *     – passing an isolating scope (≠ bindScopeKey and ≠ bindIsolKey)
 *       blocks it;
 *     – at the location's top level, it is visible iff `bindScopeKey === 0`.
 */
export function isBindingVisible(
  path: ScopePath,
  bindScopeKey: number,
  bindIsolKey: number,
  bindIsLocal: boolean,
): boolean {
  // Globals: always visible.  (Shadowing by nested locals is handled
  // by the consumer picking the innermost visible binding — which in
  // our call-site resolver means every visible local binding is also
  // collected; the ambiguity rule disambiguates at the end.)
  if (!bindIsLocal) return true;

  // Crossing an else/elseif branch blocks the bindings of its own
  // if_block (the if-body, a sibling branch), and only those: bindings
  // in enclosing scopes (a loop body around the whole if/else) stay
  // visible. A branch further out replaces it, which is right: only the
  // innermost branch's if_block ever needs blocking.
  let blockedScopeKey = 0;  // 0 = nothing blocked
  for (let i = 0; i < path.length; i += STEP) {
    const key = path[i];
    if (key === bindScopeKey) return key !== blockedScopeKey;
    const flags = path[i + 1];
    if (flags & BRANCH) blockedScopeKey = path[i + 2];
    if ((flags & ISOLATING) && key !== bindIsolKey) return false;
  }
  return bindScopeKey === 0;
}
