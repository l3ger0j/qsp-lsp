// ── !@qsp-ignore comments ────────────────────────────────────────────
//
// Authors silence a check where its finding is intended, in the code
// itself, with a QSP comment the player ignores:
//
//   !@qsp-ignore uninitializedVariables: счёт      ← the next code line
//   *pl счёт & !@qsp-ignore uninitializedVariables ← this line (after `&`)
//   !@qsp-ignore-location unusedVariables          ← the whole location
//   !@qsp-ignore-file unresolvedLocationRefs       ← the whole file
//
// Codes are the `qsp.diagnostics.<code>` setting names (diagnosticCodes.ts);
// none means every check. Names after `:` narrow it to those variables,
// locations, labels, actions or objects. `!@` follows the community's
// preprocessor comments (`!@pp:if`). Pure text processing.

import { SUPPRESSIBLE_CODES, UNSUPPRESSIBLE_CODES } from './diagnosticCodes';

const DIRECTIVE_RE = /(^|&)(\s*)(!@qsp-ignore(?:-(location|file))?)(?![\w-])([^\r\n]*)$/i;

interface Rule {
  /** Canonical codes; null = every suppressible check. */
  codes: ReadonlySet<string> | null;
  /** Normalized names; null = any name. */
  names: ReadonlySet<string> | null;
}

/** A mistake in a directive, to be reported where it is written (0-based). */
export interface SuppressionProblem {
  line: number;
  startCol: number;
  endCol: number;
  message: string;
}

/** The directives of one file. */
export interface Suppressions {
  /** Whether a finding of `code` about `name` on `line` (0-based) is silenced. */
  isSuppressed(code: string, name: string | undefined, line: number): boolean;
  problems: readonly SuppressionProblem[];
}

/** Compare names as QSP does: without case and without the `$`/`#`/`%` type prefix. */
export function normalizeSuppressedName(name: string): string {
  return name.trim().replace(/^[$#%]/, '').toLowerCase();
}

const CANONICAL = new Map([...SUPPRESSIBLE_CODES, ...UNSUPPRESSIBLE_CODES].map(c => [c.toLowerCase(), c]));

function matches(rule: Rule, code: string, name: string | undefined): boolean {
  if (rule.codes && !rule.codes.has(code)) return false;
  if (!rule.names) return true;
  return name !== undefined && rule.names.has(normalizeSuppressedName(name));
}

/** No directives: the common case, without splitting the text. */
export const NO_SUPPRESSIONS: Suppressions = { isSuppressed: () => false, problems: [] };

/**
 * Read the `!@qsp-ignore` directives of a file. `locations` gives each
 * location's first and last line (0-based), for `-location` directives.
 */
export function parseSuppressions(
  text: string,
  locations: ReadonlyArray<{ startLine: number; endLine: number }>,
): Suppressions {
  if (!/qsp-ignore/i.test(text)) return NO_SUPPRESSIONS;

  const lines = text.split(/\r\n|\r|\n/);
  const byLine = new Map<number, Rule[]>();
  const ranges: Array<{ from: number; to: number; rule: Rule }> = [];
  const fileRules: Rule[] = [];
  const problems: SuppressionProblem[] = [];

  lines.forEach((lineText, line) => {
    const m = DIRECTIVE_RE.exec(lineText);
    if (!m) return;
    const [, before, space, keyword, scope, rest] = m;
    const keywordCol = m.index + before.length + space.length;
    const argsCol = keywordCol + keyword.length;

    const colon = rest.indexOf(':');
    const codePart = colon >= 0 ? rest.slice(0, colon) : rest;
    const namePart = colon >= 0 ? rest.slice(colon + 1) : '';

    const codes = new Set<string>();
    const tokenRe = /[^\s,]+/g;
    let t: RegExpExecArray | null;
    while ((t = tokenRe.exec(codePart))) {
      const token = t[0];
      const canonical = CANONICAL.get(token.toLowerCase());
      const startCol = argsCol + t.index;
      const where = { line, startCol, endCol: startCol + token.length };
      if (canonical && SUPPRESSIBLE_CODES.has(canonical)) {
        codes.add(canonical);
      } else if (canonical) {
        problems.push({ ...where, message: `'${canonical}' can't be ignored: it marks something the game or the build can't work with` });
      } else {
        problems.push({ ...where, message: `Unknown check '${token}' in ${keyword}; checks are named like their qsp.diagnostics settings, e.g. unusedVariables` });
      }
    }
    // A directive whose only codes were wrong silences nothing rather than everything.
    if (codes.size === 0 && /[^\s,]/.test(codePart)) return;

    const names = namePart.split(',').map(normalizeSuppressedName).filter(n => n !== '');
    const rule: Rule = { codes: codes.size > 0 ? codes : null, names: names.length > 0 ? new Set(names) : null };

    const kind = scope?.toLowerCase();
    if (kind === 'file') {
      fileRules.push(rule);
    } else if (kind === 'location') {
      const loc = locations.find(l => l.startLine <= line && line <= l.endLine);
      if (!loc) {
        problems.push({ line, startCol: keywordCol, endCol: argsCol, message: `${keyword} must be inside a location` });
        return;
      }
      ranges.push({ from: loc.startLine, to: loc.endLine, rule });
    } else if (before === '&') {
      mapPush(byLine, line, rule);
    } else {
      // The next line with code: directives can be stacked, and a blank
      // line or a note between them and the code doesn't break the link.
      let target = line + 1;
      while (target < lines.length && /^\s*(!.*)?$/.test(lines[target])) target++;
      mapPush(byLine, target, rule);
    }
  });

  return {
    problems,
    isSuppressed(code, name, line) {
      if (UNSUPPRESSIBLE_CODES.has(code)) return false;
      if (fileRules.some(r => matches(r, code, name))) return true;
      if (byLine.get(line)?.some(r => matches(r, code, name))) return true;
      return ranges.some(r => r.from <= line && line <= r.to && matches(r.rule, code, name));
    },
  };
}

function mapPush<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
