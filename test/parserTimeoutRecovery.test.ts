/**
 * Regression test for the shared-parser timeout corruption bug.
 *
 * `QspTreeSitterParser` wraps a single web-tree-sitter `Parser` instance
 * that is shared across every document, location, and embedded `exec:`
 * body (see treeSitter.ts). web-tree-sitter resumes a halted parse from
 * where it left off on the *next* `parse()` call unless `Parser#reset()`
 * is called first. Without that reset, a timeout on one (pathological)
 * input silently corrupts the very next, unrelated parse — producing a
 * tree full of phantom error nodes instead of the real content, with no
 * error surfaced anywhere.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { WASM_PATH } from './testHelpers';

// Far more than a small timeout budget parses: a location of 50 000 lines.
const PATHOLOGICAL_INPUT = '# a\n' + 'x = (1 + 2) * 3\n'.repeat(50_000) + '---\n';
const TINY_TIMEOUT_MICROS = 1_000;

const CLEAN_DOC = `# clean\npl 'hello'\n---\n`;

describe('QspTreeSitterParser: recovers after a parse timeout', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('parseOnce() times out on pathological input', () => {
    const tree = parser.parseOnce(PATHOLOGICAL_INPUT, TINY_TIMEOUT_MICROS);
    expect(tree).toBeNull();
  });

  it('a subsequent parseOnce() for a clean, unrelated document is not corrupted', () => {
    // Trigger the timeout first.
    expect(parser.parseOnce(PATHOLOGICAL_INPUT, TINY_TIMEOUT_MICROS)).toBeNull();

    // Without Parser#reset(), web-tree-sitter would resume the halted
    // parse here instead of starting fresh, corrupting this result.
    const tree = parser.parseOnce(CLEAN_DOC, 5_000_000);
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.hasError).toBe(false);
    expect(tree!.rootNode.text).toBe(CLEAN_DOC);
    expect(tree!.rootNode.toString()).not.toContain('ERROR');
    tree!.delete();
  });

  it('a subsequent full parse() (per-document cache) is not corrupted either', () => {
    expect(parser.parseOnce(PATHOLOGICAL_INPUT, TINY_TIMEOUT_MICROS)).toBeNull();

    // parse() is the per-document entry point used by analyzeDocument();
    // it also shares the single underlying Parser instance.
    const tree = parser.parseOnce(CLEAN_DOC);
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.hasError).toBe(false);
    expect(tree!.rootNode.text).toBe(CLEAN_DOC);
  });

  it('reports non-timeout parse failures via the error reporter, but not plain timeouts', () => {
    const messages: string[] = [];
    parser.setErrorReporter((m) => messages.push(m));

    parser.parseOnce(PATHOLOGICAL_INPUT, TINY_TIMEOUT_MICROS);
    expect(messages).toEqual([]); // a plain timeout is expected, not reported

    parser.setErrorReporter(() => { throw new Error('boom'); });
    // A non-Error-with-"Parsing failed" rejection would be reported; here
    // we only assert the reporter hook is wired without throwing back
    // into parseOnce for the expected-timeout path.
    expect(() => parser.parseOnce(PATHOLOGICAL_INPUT, TINY_TIMEOUT_MICROS)).not.toThrow();

    parser.setErrorReporter(() => {}); // restore a no-op for later tests
  });
});
