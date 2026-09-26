#!/usr/bin/env node
// ── Stress game generator ────────────────────────────────────────────
//
// Writes a synthetic QSP game for load testing the language server
// (scripts/stress/bench.mjs). Everything is valid QSP that parses without
// errors, seeded so a run can be repeated.
//
//   node scripts/stress/genGame.mjs --out <dir> [--locations 1000]
//       [--chars 26000] [--files 1] [--profile mixed|text|code] [--seed 1]
//       [--shape report.json]
//
// --shape takes the report.json saved by "QSP: Collect Performance
// Profile" and follows it: the number of locations, their size spread,
// how often each grammar construct occurs and how long strings are. That
// is how a problem in a game that can't be shared is reproduced here.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Random numbers ───────────────────────────────────────────────────

function rng(seed) {
  let s = (seed >>> 0) || 1;
  const next = () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}

const WORDS = 'комната дверь стол окно меч ключ рыцарь замок лес река тропа свет тьма room door table window sword key knight castle'.split(' ');

// ── Profiles ─────────────────────────────────────────────────────────

// Relative frequency of each construct the generator can write, keyed by
// the grammar node type it produces (tree-sitter-qsp/grammar.js).
const PROFILES = {
  mixed: {
    act_block: 8, if_block: 6, if_inline: 6, loop_block: 1, local_statement: 3, assignment_statement: 14,
    statement: 30, user_call_statement: 2, code_block: 2, string_interpolation: 8, comment_statement: 5, label_statement: 1,
  },
  text: {
    act_block: 6, if_block: 2, if_inline: 2, assignment_statement: 3, statement: 60, string_interpolation: 12, comment_statement: 2,
  },
  code: {
    act_block: 6, if_block: 12, if_inline: 10, loop_block: 3, local_statement: 10, assignment_statement: 30,
    statement: 12, user_call_statement: 6, code_block: 4, string_interpolation: 3, comment_statement: 3, label_statement: 2,
  },
};

/** Generation settings derived from a performance report (see src/server/performanceReport.ts). */
export function optionsFromShape(report) {
  const r = report.report ?? report;
  const chars = r.locations?.chars;
  const types = r.nodeTypes?.types ?? {};
  const weights = {};
  for (const key of Object.keys(PROFILES.mixed)) {
    if (types[key]?.count) weights[key] = types[key].count;
  }
  const strings = ['double_quoted_string', 'single_quoted_string'].map(t => types[t]).filter(Boolean);
  const stringCount = strings.reduce((n, t) => n + t.count, 0);
  const stringChars = strings.reduce((n, t) => n + t.chars, 0);
  const locations = chars?.count || 1000;
  return {
    locations,
    sizes: chars ? [chars.min, chars.median, chars.p90, chars.p99, chars.max] : undefined,
    files: Math.max(1, r.files?.length ?? 1),
    weights: Object.keys(weights).length > 0 ? weights : PROFILES.mixed,
    stringChars: stringCount > 0 ? Math.max(4, Math.round(stringChars / stringCount)) : 40,
    variables: Math.max(20, r.globalBindings?.variables ?? 200),
    maxDepth: Math.min(12, Math.max(2, Math.round((r.nodeTypes?.maxDepth ?? 12) / 4))),
  };
}

// A location size from the report's quantiles (min, median, p90, p99,
// max), interpolating between them so the spread matches.
function sampleSize(r, sizes, fallback) {
  if (!sizes) return Math.max(200, Math.round(fallback * (0.5 + r.next())));
  const [min, median, p90, p99, max] = sizes;
  const u = r.next();
  const lerp = (a, b, t) => Math.round(a + (b - a) * t);
  if (u < 0.5) return lerp(min, median, u / 0.5);
  if (u < 0.9) return lerp(median, p90, (u - 0.5) / 0.4);
  if (u < 0.99) return lerp(p90, p99, (u - 0.9) / 0.09);
  return lerp(p99, max, (u - 0.99) / 0.01);
}

// ── Code ─────────────────────────────────────────────────────────────

function makeWriter(r, opts, locationCount) {
  const weightEntries = Object.entries(opts.weights);
  const total = weightEntries.reduce((n, [, w]) => n + w, 0);
  const pickKind = () => {
    let x = r.next() * total;
    for (const [k, w] of weightEntries) if ((x -= w) < 0) return k;
    return weightEntries[0][0];
  };
  const text = () => {
    let s = '';
    while (s.length < opts.stringChars) s += (s ? ' ' : '') + r.pick(WORDS);
    return s;
  };
  const sv = () => `$s_${r.int(opts.variables)}`;
  const nv = () => `n_${r.int(opts.variables)}`;
  const target = (i) => locName(Math.min(locationCount - 1, Math.max(0, i + r.int(21) - 10)));
  let labels = 0;

  // One construct at `indent`, of about `budget` characters at most:
  // nested bodies share it, so deep nesting can't blow a location up.
  // `depth` limits the nesting itself.
  const write = (i, indent, depth, budget) => {
    const kind = depth >= opts.maxDepth || budget < 400 ? 'statement' : pickKind();
    const pad = '\t'.repeat(indent);
    const body = (n) => Array.from({ length: n }, () => write(i, indent + 1, depth + 1, budget / (n + 3))).join('');
    switch (kind) {
      case 'act_block':
        return `${pad}act '${text().slice(0, 30)}':\n${body(2)}${pad}end\n`;
      case 'if_block':
        return `${pad}if ${nv()} > ${r.int(100)} and ${sv()} = '':\n${body(2)}${pad}elseif ${nv()} < 0:\n${body(1)}${pad}else\n${body(1)}${pad}end\n`;
      case 'if_inline':
        return `${pad}if ${nv()} >= ${r.int(10)}: ${sv()} = '${text()}'\n`;
      case 'loop_block':
        return `${pad}loop local j = 0 while j < ${1 + r.int(5)} step j += 1:\n${body(1)}${pad}end\n`;
      case 'local_statement':
        return `${pad}local ${nv()}, ${sv()} = ${r.int(100)}, '${text()}'\n`;
      case 'assignment_statement':
        return r.next() < 0.5
          ? `${pad}${sv()} = '${text()}' + ${sv()}\n`
          : `${pad}${nv()} += ${r.int(10)}\n`;
      case 'user_call_statement':
        return `${pad}@@${target(i)}(${r.int(9)}, '${text().slice(0, 12)}')\n`;
      case 'code_block': {
        if (r.next() < 0.5) return `${pad}dynamic {\n${pad}\t*pl '${text()}'\n${pad}\tgs '${target(i)}'\n${pad}}\n`;
        // A block kept in a variable and run later; the small pool per
        // location makes blocks run each other, like menus opening menus.
        const own = r.int(4), other = r.int(4);
        return `${pad}$blk_${own} = {\n${pad}\t${nv()} += 1\n${pad}\t*pl '${text()}'\n${pad}\tif ${nv()} < 0: dynamic $blk_${other}\n${pad}}\n`
          + `${pad}dynamic $blk_${own}\n`;
      }
      case 'string_interpolation':
        return `${pad}*pl "${text()} <<${sv()}>> ${text()}"\n`;
      case 'comment_statement':
        return `${pad}! ${text()}\n`;
      case 'label_statement': {
        const label = `lbl_${labels++}`;
        return `${pad}:${label}\n${pad}if ${nv()} < 0: jump '${label}'\n`;
      }
      default: {
        const k = r.int(8);
        if (k === 0) return `${pad}gt '${target(i)}'\n`;
        if (k === 1) return `${pad}gs '${target(i)}', '${text().slice(0, 10)}', ${r.int(9)}\n`;
        if (k === 2) return `${pad}${sv()} = '${target(i)}'\n${pad}gt ${sv()}\n`;
        if (k === 3) return r.next() < 0.5 ? `${pad}${nv()} = func('${target(i)}', ${r.int(5)})\n` : `${pad}${nv()} = @${target(i)}(${r.int(5)})\n`;
        if (k === 4) return `${pad}addobj '${text().slice(0, 16)}'\n`;
        if (k === 5) return `${pad}xgt 'loc_' + $str(${r.int(locationCount)})\n`;
        return `${pad}*pl '${text()}'\n`;
      }
    }
  };
  return write;
}

function locName(i) {
  // A few Cyrillic names, as real games have them.
  return i % 7 === 3 ? `локация_${i}` : `loc_${i}`;
}

/**
 * Generate a game. Returns its files as `{ name, text }` and the number
 * of locations; writes nothing.
 */
export function generateGame(input = {}) {
  const profile = PROFILES[input.profile ?? 'mixed'] ?? PROFILES.mixed;
  const opts = {
    locations: 1000, chars: 26000, files: 1, seed: 1, stringChars: 40, variables: 200, maxDepth: 3,
    ...input,
    weights: input.weights ?? profile,
  };
  const r = rng(opts.seed);
  const write = makeWriter(r, opts, opts.locations);
  const files = Array.from({ length: opts.files }, () => []);
  for (let i = 0; i < opts.locations; i++) {
    const size = sampleSize(r, opts.sizes, opts.chars);
    const name = locName(i);
    let s = `# ${name}\n`;
    while (s.length < size) s += write(i, 0, 0, size - s.length);
    s += `--- ${name} ---------------------------------\n\n`;
    files[Math.floor((i * opts.files) / opts.locations)].push(s);
  }
  return {
    locations: opts.locations,
    files: files.map((parts, j) => ({ name: `part${String(j).padStart(3, '0')}.qsps`, text: parts.join('') })),
  };
}

// ── Command line ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    out[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    console.error('usage: genGame.mjs --out <dir> [--locations N] [--chars N] [--files N] [--profile mixed|text|code] [--seed N] [--shape report.json]');
    process.exit(2);
  }
  let input = {};
  if (args.shape) input = optionsFromShape(JSON.parse(fs.readFileSync(args.shape, 'utf8')));
  for (const key of ['locations', 'chars', 'files', 'seed']) if (args[key]) input[key] = Number(args[key]);
  if (args.profile) input.profile = args.profile;
  const game = generateGame(input);
  fs.mkdirSync(args.out, { recursive: true });
  let total = 0;
  for (const f of game.files) {
    fs.writeFileSync(path.join(args.out, f.name), f.text);
    total += f.text.length;
  }
  console.log(`${game.locations} locations in ${game.files.length} files, ${(total / 1e6).toFixed(1)} M chars → ${args.out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
