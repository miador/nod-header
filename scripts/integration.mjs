#!/usr/bin/env node
/**
 * Runs the integration suite against one browser.
 *
 * It exists so the browser choice is an argument rather than an environment
 * variable in a package script: `FOO=bar node ...` is not portable to every
 * shell, and the suite is meant to be as easy to run on a laptop as in CI.
 *
 * Usage:
 *   node scripts/integration.mjs                                 Chrome
 *   node scripts/integration.mjs --browser=firefox
 *   node scripts/integration.mjs --browser=firefox --engine=webrequest
 *   node scripts/integration.mjs --browser=edge --headful
 *   node scripts/integration.mjs --browser=edge --require
 *
 * --engine=webrequest turns declarativeNetRequest off in Firefox so the
 * blocking-webRequest fallback is the code under test. --require turns "that
 * browser is not installed" from a skip into a failure, which is what CI wants:
 * a run that quietly tested nothing should not report success. Anything else is
 * passed through to node --test.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SUITE = join('integration', 'headers.test.js');

const BROWSERS = new Set(['chrome', 'edge', 'firefox']);
const TARGET_OF = { chrome: 'chrome', edge: 'chrome', firefox: 'firefox' };

function parseArgs(argv) {
  const args = { browser: 'chrome', engine: 'auto', headful: false, require: false, rest: [] };
  for (const arg of argv) {
    if (arg.startsWith('--browser=')) args.browser = arg.slice(10).toLowerCase();
    else if (arg.startsWith('--engine=')) args.engine = arg.slice(9).toLowerCase();
    else if (arg === '--headful') args.headful = true;
    else if (arg === '--require') args.require = true;
    else args.rest.push(arg);
  }
  if (!BROWSERS.has(args.browser)) {
    throw new Error(`--browser must be one of ${[...BROWSERS].join(', ')}, not '${args.browser}'`);
  }
  return args;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`integration: ${err.message}\n`);
  process.exit(1);
}

const target = TARGET_OF[args.browser];
if (!existsSync(join(ROOT, 'dist', target, 'manifest.json'))) {
  process.stderr.write(
    `integration: dist/${target} has no build in it. Run: node scripts/build.mjs --target=${target}\n`,
  );
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', SUITE, ...args.rest], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    NOD_BROWSER: args.browser,
    NOD_ENGINE: args.engine,
    ...(args.headful ? { NOD_HEADFUL: '1' } : {}),
    ...(args.require ? { NOD_REQUIRE_BROWSER: '1' } : {}),
  },
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
