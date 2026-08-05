#!/usr/bin/env node
/**
 * The version, in one place.
 *
 * package.json is the single source of truth: scripts/build.mjs stamps it into
 * both manifests and into the zip filenames. This script is how a release moves
 * it, so a workflow never has to edit JSON with a regular expression.
 *
 * Usage:
 *   node scripts/version.mjs                     print the current version
 *   node scripts/version.mjs --bump=patch        1.2.3 -> 1.2.4
 *   node scripts/version.mjs --bump=minor        1.2.3 -> 1.3.0
 *   node scripts/version.mjs --bump=major        1.2.3 -> 2.0.0
 *   node scripts/version.mjs --set=1.4.0         set it outright, v-prefix ok
 *   node scripts/version.mjs --set=1.4.0 --check fail unless it is already 1.4.0
 *
 * The new version is the only thing on stdout, so a workflow can read it with
 * a command substitution. Everything else goes to stderr.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = join(ROOT, 'package.json');

/**
 * Semantic versioning, minus the parts a browser will not accept. Chrome and
 * Firefox both parse `version` as up to four dot-separated integers, so
 * `1.4.0-rc.1` is not a version an extension can ship under: the manifest is
 * rejected outright. A prerelease has to become its own number instead.
 */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_PART = 65535;

class VersionError extends Error {}

function parse(input) {
  const raw = String(input ?? '').trim().replace(/^v/, '');
  const parts = SEMVER.exec(raw);

  if (!parts) {
    const extra = /[-+]/.test(raw)
      ? ' A browser extension version cannot carry a prerelease or build suffix — '
        + 'use a plain MAJOR.MINOR.PATCH number.'
      : '';
    throw new VersionError(`'${input}' is not a MAJOR.MINOR.PATCH version.${extra}`);
  }

  const numbers = parts.slice(1, 4).map(Number);
  const over = numbers.find((n) => n > MAX_PART);
  if (over !== undefined) {
    throw new VersionError(`${raw} has a part above ${MAX_PART}, which browsers will not accept.`);
  }
  return numbers;
}

function format([major, minor, patch]) {
  return `${major}.${minor}.${patch}`;
}

function bump(current, kind) {
  const [major, minor, patch] = parse(current);
  if (kind === 'major') return format([major + 1, 0, 0]);
  if (kind === 'minor') return format([major, minor + 1, 0]);
  if (kind === 'patch') return format([major, minor, patch + 1]);
  throw new VersionError(`--bump must be major, minor or patch, not '${kind}'`);
}

function parseArgs(argv) {
  const args = { bump: null, set: null, check: false, dryRun: false };
  for (const arg of argv) {
    if (arg.startsWith('--bump=')) args.bump = arg.slice(7);
    else if (arg.startsWith('--set=')) args.set = arg.slice(6);
    else if (arg === '--check') args.check = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else throw new VersionError(`unknown option '${arg}'`);
  }
  if (args.bump && args.set) throw new VersionError('pass --bump or --set, not both');
  if (args.check && !args.set) throw new VersionError('--check needs --set=VERSION');
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const source = readFileSync(PKG, 'utf8');
  const pkg = JSON.parse(source);
  const current = format(parse(pkg.version));

  if (!args.bump && !args.set) {
    process.stdout.write(`${current}\n`);
    return;
  }

  const next = args.set ? format(parse(args.set)) : bump(current, args.bump);

  if (args.check && next !== current) {
    throw new VersionError(`package.json is at ${current}, not ${next}`);
  }

  if (next === current) {
    process.stderr.write(`version is already ${current}\n`);
    process.stdout.write(`${current}\n`);
    return;
  }

  if (!args.dryRun) {
    // Rewrite only the version line so nothing else about the file — key order,
    // indentation, trailing newline — depends on how JSON.stringify feels today.
    const updated = source.replace(
      /("version"\s*:\s*")[^"]*(")/,
      (whole, before, after) => `${before}${next}${after}`,
    );
    if (!updated.includes(`"version": "${next}"`)) {
      throw new VersionError('could not find the version field to rewrite in package.json');
    }
    writeFileSync(PKG, updated);
  }

  process.stderr.write(`${current} -> ${next}${args.dryRun ? ' (dry run)' : ''}\n`);
  process.stdout.write(`${next}\n`);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof VersionError) {
    process.stderr.write(`version: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
