#!/usr/bin/env node
/**
 * Fail a release that still carries a placeholder. Node built-ins only.
 *
 * Usage: node scripts/check-placeholders.mjs [--strict]
 *
 *   default   report what is left and exit 0, so an ordinary CI run stays green
 *             while still showing the list
 *   --strict  exit 1 on the first finding, which is how the release workflow
 *             uses it
 *
 * These are not cosmetic. `SECURITY.md` links to the private-advisory form, and
 * a link pointing at a repository that does not exist sends someone holding a
 * credential-disclosure bug to a public issue instead — the one outcome that
 * policy exists to prevent. The others are a clone command nobody can run and a
 * code of conduct with no address to report to.
 *
 * Only prose and workflow files are scanned. `scripts/` is left out so the token
 * list below does not match itself.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Where a placeholder can hide. Directories are walked, files read as-is. */
const SCAN = ['.github', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md',
  'PRIVACY.md', 'README.md', 'SECURITY.md'];

const EXTENSIONS = ['.md', '.yml', '.yaml'];

/**
 * Each token is the literal text to find and the thing to do about it. Written
 * as fragments so the file does not trip its own check.
 */
const TOKENS = [
  {
    find: `your${'-'}org/nod-header`,
    fix: 'Replace with the real GitHub owner and repository, e.g. octocat/nod-header.',
  },
  {
    find: `[MAINTAINER${' '}EMAIL]`,
    fix: 'Replace with the address that receives code-of-conduct reports.',
  },
];

function walk(path) {
  const found = [];
  if (statSync(path).isFile()) {
    if (EXTENSIONS.some((ext) => path.endsWith(ext))) found.push(path);
    return found;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;
    found.push(...walk(join(path, entry.name)));
  }
  return found;
}

const files = [];
for (const target of SCAN) {
  const full = join(ROOT, target);
  try {
    files.push(...walk(full));
  } catch {
    // A document that is not there yet cannot hold a placeholder.
  }
}

const findings = [];
for (const file of files.sort()) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const token of TOKENS) {
      if (line.includes(token.find)) {
        findings.push({ file: relative(ROOT, file), line: index + 1, token });
      }
    }
  });
}

const strict = process.argv.includes('--strict');
// GitHub turns these into annotations on the run; elsewhere they are just a
// readable prefix.
const level = strict ? 'error' : 'warning';

if (!findings.length) {
  console.log('No placeholders left.');
  process.exit(0);
}

for (const { file, line, token } of findings) {
  console.log(`::${level} file=${file},line=${line}::${token.find} is still here. ${token.fix}`);
  console.log(`${file}:${line}  ${token.find}  —  ${token.fix}`);
}

const count = `${findings.length} placeholder${findings.length === 1 ? '' : 's'}`;
if (strict) {
  console.error(`\n${count} left. Fill these in before publishing.`);
  process.exit(1);
}
console.log(`\n${count} left. This is a warning here; the release workflow refuses to publish with them.`);
