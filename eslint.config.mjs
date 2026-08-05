/**
 * ESLint, flat config.
 *
 * These are the only dependencies the project has, they are all development-only
 * and nothing from them reaches a published package. The rule set is chosen to
 * catch the mistakes this codebase can actually make rather than to enforce a
 * house style: formatting is documented in CONTRIBUTING.md and left to the
 * author, because reformatting 11,000 lines would bury the history that explains
 * why the code looks the way it does.
 *
 * Two things here earn their place beyond the usual:
 *
 *   1. `no-undef` with globals written out by hand, not pulled from a package.
 *      Because `chrome` and `browser` are deliberately absent from every list,
 *      a bare `chrome.storage.…` anywhere in the project is an undefined
 *      variable. That is the "one namespace for browser APIs" rule from
 *      CONTRIBUTING.md, enforced by a machine instead of by a reviewer.
 *   2. `no-restricted-syntax` on `globalThis.chrome` and `globalThis.browser`,
 *      which closes the other way round the same rule — src/lib/browser.js is
 *      the single place allowed to look.
 */
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import json from '@eslint/json';
import { fileURLToPath } from 'node:url';

// One list of ignored paths, and .gitignore is already it: dist/, node_modules/
// and the rest stay in one place instead of drifting between two files.
const gitignore = fileURLToPath(new URL('.gitignore', import.meta.url));

const timers = { setTimeout: 'readonly', clearTimeout: 'readonly' };

/** The background worker and the pure modules: no DOM, no Node. */
const workerGlobals = {
  ...timers,
  console: 'readonly',
  structuredClone: 'readonly',
};

/** The popup and the options page. */
const pageGlobals = {
  ...timers,
  console: 'readonly',
  structuredClone: 'readonly',
  document: 'readonly',
  window: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  matchMedia: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
};

/** The build, the tests and the integration harness. */
const nodeGlobals = {
  ...timers,
  console: 'readonly',
  structuredClone: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  fetch: 'readonly',
  WebSocket: 'readonly',
};

/**
 * The rules that are about being able to read and change this code later, on top
 * of everything `recommended` already covers.
 */
const clarity = {
  // Found a real bug: a state read still in flight overwriting a newer write.
  'require-atomic-updates': 'error',
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'prefer-const': 'error',
  // Shadowing is how a fix gets applied to the wrong binding.
  'no-shadow': 'error',
  'no-else-return': ['error', { allowElseIf: false }],
  'no-lonely-if': 'error',
  'no-unneeded-ternary': 'error',
  'no-useless-return': 'error',
  'default-case-last': 'error',
  'object-shorthand': ['error', 'always'],
  'prefer-template': 'error',
  radix: 'error',
  // console.error is how the worker reports what it could not do; a stray
  // console.log is debugging left behind.
  'no-console': ['error', { allow: ['error', 'warn'] }],
};

const noDirectNamespace = {
  'no-restricted-syntax': ['error', {
    selector: "MemberExpression[object.name='globalThis'][property.name=/^(chrome|browser)$/]",
    message: 'Import `api` from src/lib/browser.js instead of reaching for the namespace directly.',
  }],
};

export default [
  includeIgnoreFile(gitignore),

  // ── JavaScript ────────────────────────────────────────────────────────────
  {
    files: ['**/*.js', '**/*.mjs'],
    ...js.configs.recommended,
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: { ...js.configs.recommended.rules, ...clarity, ...noDirectNamespace },
  },

  {
    files: ['src/lib/**/*.js', 'src/background/**/*.js'],
    languageOptions: { globals: workerGlobals },
  },

  {
    // The one module allowed to ask which namespace this browser has.
    files: ['src/lib/browser.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    files: ['src/popup/**/*.js', 'src/options/**/*.js'],
    languageOptions: { globals: pageGlobals },
  },

  {
    files: ['scripts/**/*.mjs', 'test/**/*.js', 'integration/**/*.js', '*.mjs'],
    languageOptions: { globals: nodeGlobals },
    rules: {
      // These are command-line tools and test reporters. Printing is what they
      // are for, so the rule that keeps stray debugging out of the extension
      // would only be noise here.
      'no-console': 'off',
    },
  },

  {
    // Both suites reach for the namespace on purpose: the fake installs one, and
    // the integration harness names `chrome` and `browser` in strings it sends
    // to a real browser to evaluate.
    files: ['test/**/*.js', 'integration/**/*.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    // Two storage tests hold a read open across a write to reproduce a race on
    // purpose. The rule cannot tell a reproduction from a mistake.
    files: ['test/**/*.js'],
    rules: { 'require-atomic-updates': 'off' },
  },

  // ── JSON ──────────────────────────────────────────────────────────────────
  // Both manifests are hand-edited and `JSON.parse` accepts a duplicate key in
  // silence, keeping the last one — which is exactly how a permission or a
  // version floor gets quietly overridden by an older copy of itself.
  {
    files: ['**/*.json'],
    ignores: ['package-lock.json'],
    language: 'json/json',
    plugins: { json },
    rules: {
      'json/no-duplicate-keys': 'error',
      'json/no-empty-keys': 'error',
      'json/no-unsafe-values': 'error',
      'json/no-unnormalized-keys': 'error',
    },
  },
];
