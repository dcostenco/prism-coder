#!/usr/bin/env node
/**
 * lint-dashboard-es5.js
 *
 * Scans src/dashboard/ui.ts for two classes of bugs that break the
 * template-literal-embedded inline script block:
 *
 *  1. ES6+ syntax: arrow functions, const/let, backticks inside the script.
 *     The inline <script> must be ES5-only (no transpilation step).
 *
 *  2. Quote-escaping trap: patterns like \'' + p.id + '\' where a single
 *     backslash before a quote inside a template literal is consumed as an
 *     escape sequence (\'  →  '), stripping the backslash from the output
 *     and breaking the browser's JS parser.
 *     Safe alternatives: use data-id attributes (this.dataset.id), or
 *     ensure double-backslash \\' so the template literal outputs \'.
 *
 * Run: node scripts/lint-dashboard-es5.js
 * Exit 0 = clean, Exit 1 = violations found.
 */

const fs = require('fs');
const path = require('path');

const TARGET = path.resolve(__dirname, '../src/dashboard/ui.ts');
const source = fs.readFileSync(TARGET, 'utf-8');
const lines = source.split('\n');

// ── Locate the inline <script> block inside the template literal ──
// We scan between the first `<script>` and matching `</script>` inside
// the renderDashboardHTML template literal.
let inScript = false;
let errors = 0;

const ES6_PATTERNS = [
  { re: /(?<![a-zA-Z0-9_$])const\s+/, label: 'const declaration (use var)' },
  { re: /(?<![a-zA-Z0-9_$])let\s+/,   label: 'let declaration (use var)'   },
  { re: /=>\s*[{(]/,                   label: 'arrow function (=>) — not ES5' },
];

// Matches the dangerous escape sequence: a lone \' (not \\') inside an
// inline JS string that's itself inside the template literal.
// The pattern catches:  \'' + <anything> + '\
// which signals the writer intended to pass a variable with quote-wrapping
// but used the wrong number of backslashes.
const LONE_ESCAPE_QUOTE = /\\''[^']/;   // \'' followed by non-quote char
const LONE_CLOSE_QUOTE  = /[^\\]'\\'/;  // non-backslash ' then \'

lines.forEach((raw, i) => {
  const lineNum = i + 1;
  const trimmed = raw.trim();

  // Toggle script block tracking
  if (trimmed.includes('<script>') && !trimmed.includes('</script>')) {
    inScript = true;
    return;
  }
  if (trimmed.includes('</script>')) {
    inScript = false;
    return;
  }
  if (!inScript) return;

  // ── Check 1: ES6+ syntax ──
  // Skip comment-only lines — they don't affect runtime
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
  for (const { re, label } of ES6_PATTERNS) {
    if (re.test(trimmed)) {
      console.error(`[dashboard-es5] Line ${lineNum}: ES6 violation — ${label}`);
      console.error(`  ${raw}`);
      errors++;
    }
  }

  // ── Check 2: lone-backslash quote-escape trap ──
  // Flag patterns like: \'' + varName  or  varName + '\'
  // These produce '' (no backslash) in the served HTML, breaking JS parsing.
  if (LONE_ESCAPE_QUOTE.test(trimmed)) {
    console.error(`[dashboard-es5] Line ${lineNum}: Quote-escape trap — \\'' in template literal produces '' (no backslash) in served HTML.`);
    console.error(`  Hint: use this.dataset.id or ensure \\\\' (double-backslash) for literal backslash in output.`);
    console.error(`  ${raw}`);
    errors++;
  }
  if (LONE_CLOSE_QUOTE.test(trimmed)) {
    console.error(`[dashboard-es5] Line ${lineNum}: Quote-escape trap — \\' at close of inline string produces ' not \\' in served HTML.`);
    console.error(`  Hint: use this.dataset.id or ensure \\\\' (double-backslash) for literal backslash in output.`);
    console.error(`  ${raw}`);
    errors++;
  }
});

if (errors === 0) {
  console.log('[dashboard-es5] OK — no ES6 or quote-escape violations found.');
  process.exit(0);
} else {
  console.error(`[dashboard-es5] FAIL — ${errors} violation(s) found. Fix before committing.`);
  process.exit(1);
}
