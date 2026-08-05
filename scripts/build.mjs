#!/usr/bin/env node
/**
 * Nod Header build. Node built-ins only, no dependencies.
 *
 * Usage: node scripts/build.mjs [--target=chrome|firefox|all] [--zip] [--root=DIR]
 *
 * The pages ship as the ES modules they already are. The background cannot:
 * Chrome loads it as a module service worker, Firefox as one classic script, so
 * it is bundled into a single IIFE that is valid under both. Only the narrow
 * module syntax described in MODULE SUBSET below survives that transform, and
 * anything else fails the build with a file and line instead of shipping broken.
 */
import { deflateRawSync } from 'node:zlib';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { crc32, ICON_SIZES, iconName, writeIcons } from './make-icons.mjs';

const TARGETS = ['chrome', 'firefox'];
const COPY_DIRS = ['popup', 'options', 'shared', 'lib', 'assets'];
const ENTRY = 'background/service-worker.js';

const USAGE = `Nod Header build

Usage: node scripts/build.mjs [options]

  --target=chrome|firefox|all   which build to produce (default all)
  --zip                         also write dist/nod-header-<target>-<version>.zip
  --root=DIR                    repository root to read and write (default the checkout)
  --help                        show this message`;

class BuildError extends Error {}

// ── module subset ──────────────────────────────────────────────────────────
// import { a, b } from './rel/path.js';   relative, .js, named only
// export const X / export let X / export function f / export class C
// No default, no lists, no re-exports, no namespaces, no dynamic import.

/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

function regexAllowed(chars, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(chars[i])) i -= 1;
  if (i < 0) return true;
  const c = chars[i];
  if (c === ')' || c === ']' || c === '}' || c === '\'' || c === '"' || c === '`') return false;
  if (/[\w$]/.test(c)) {
    let k = i;
    while (k >= 0 && /[\w$]/.test(chars[k])) k -= 1;
    return REGEX_AFTER.has(chars.slice(k + 1, i + 1).join(''));
  }
  return true;
}

/**
 * A copy of `src` with the inside of every comment, string, template and regex
 * literal replaced by spaces, newlines kept so offsets and line numbers still
 * line up. Scanning the mask instead of the source means a word like "export"
 * in a comment or a quote inside a character class cannot fool the parser.
 */
/** The newline ending the `//` comment at `i`, or the end of the source. */
function endOfLineComment(src, i, n) {
  let j = i;
  while (j < n && src[j] !== '\n') j += 1;
  return j;
}

/** Just past the delimiter closing the block comment at `i`. */
function endOfBlockComment(src, i, n) {
  let j = i + 2;
  while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
  return Math.min(n, j + 2);
}

/** The quote closing the string at `i`, or the newline that cuts it short. */
function endOfString(src, i, n) {
  const quote = src[i];
  let j = i + 1;
  while (j < n && src[j] !== quote && src[j] !== '\n') {
    j += src[j] === '\\' ? 2 : 1;
  }
  return j;
}

/** The `/` closing the regex literal at `i`. A `/` inside a class is a literal. */
function endOfRegex(src, i, n) {
  let j = i + 1;
  let inClass = false;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '\n') break;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) break;
    j += 1;
  }
  return j;
}

/** Past the flags trailing a regex literal. */
function endOfRegexFlags(src, i, n) {
  let j = i;
  while (j < n && /[a-z]/.test(src[j])) j += 1;
  return j;
}

/**
 * One character inside a template literal: `${` opens an expression, a backtick
 * closes the template, and everything else is content and gets blanked.
 */
function stepTemplate(src, i, modes, blank) {
  const c = src[i];
  if (c === '\\') { blank(i, i + 2); return i + 2; }
  if (c === '`') { modes.pop(); return i + 1; }
  if (c === '$' && src[i + 1] === '{') { modes.push({ kind: 'expr', depth: 0 }); return i + 2; }
  blank(i, i + 1);
  return i + 1;
}

/** A brace inside a `${…}`, so the one that matches pops back to the template. */
function stepExprBrace(c, mode, modes, i) {
  if (c === '{') mode.depth += 1;
  else if (mode.depth === 0) modes.pop();
  else mode.depth -= 1;
  return i + 1;
}

/** One token of ordinary code. Returns the index the scan carries on from. */
function stepCode(src, out, i, n, modes, mode, blank) {
  const c = src[i];
  const d = src[i + 1];
  if (c === '/' && d === '/') {
    const j = endOfLineComment(src, i, n);
    blank(i, j);
    return j;
  }
  if (c === '/' && d === '*') {
    const j = endOfBlockComment(src, i, n);
    blank(i, j);
    return j;
  }
  if (c === '\'' || c === '"') {
    const j = endOfString(src, i, n);
    blank(i + 1, j);
    return j + 1;
  }
  if (c === '`') {
    modes.push({ kind: 'template' });
    return i + 1;
  }
  if (c === '/' && regexAllowed(out, i)) {
    const j = endOfRegex(src, i, n);
    blank(i + 1, j);
    return endOfRegexFlags(src, j + 1, n);
  }
  if ((c === '{' || c === '}') && mode.kind === 'expr') return stepExprBrace(c, mode, modes, i);
  return i + 1;
}

function maskCode(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => {
    for (let i = Math.max(0, from); i < Math.min(n, to); i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };
  const modes = [{ kind: 'code', depth: 0 }];
  let i = 0;

  while (i < n) {
    const mode = modes[modes.length - 1];
    i = mode.kind === 'template'
      ? stepTemplate(src, i, modes, blank)
      : stepCode(src, out, i, n, modes, mode, blank);
  }
  return out.join('');
}

const lineAt = (src, offset) => src.slice(0, offset).split('\n').length;

const OPENS = '([{';
const CLOSES = ')]}';

/** The end of the identifier starting at `i`. */
function endOfName(text, i) {
  let j = i;
  while (j < text.length && /[\w$]/.test(text[j])) j += 1;
  return j;
}

/** Names declared by one `const`/`let`/`var` statement head, `a` and `b` in `a = 1, b = 2`. */
function declaredNames(text) {
  const names = [];
  let depth = 0;
  let expect = true;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (OPENS.includes(c)) depth += 1;
    else if (CLOSES.includes(c)) depth -= 1;
    else if (depth === 0 && c === ';') break;
    else if (depth === 0 && c === ',') expect = true;
    else if (expect && /[A-Za-z_$]/.test(c)) {
      const j = endOfName(text, i);
      names.push(text.slice(i, j));
      expect = false;
      i = j;
      continue;
    }
    i += 1;
  }
  return names;
}

function resolveDep(fromId, spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    throw new BuildError(`'${spec}' is not a relative path — bare specifiers cannot be bundled`);
  }
  if (!spec.endsWith('.js')) {
    throw new BuildError(`'${spec}' must end with .js`);
  }
  const id = posix.normalize(posix.join(posix.dirname(fromId), spec));
  if (id.startsWith('..')) throw new BuildError(`'${spec}' resolves outside src/`);
  return id;
}

/** The names one `import { a, b as c }` binds, as `require` destructuring text. */
function importBindings(list, where, at) {
  return list.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const named = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(entry);
    if (!named) throw new BuildError(`${where(at)} cannot read the import '${entry}'`);
    return named[2] ? `${named[1]}: ${named[2]}` : named[1];
  });
}

/**
 * Imports become destructuring `require` calls. Only the static named form is
 * supported, so every other spelling is a build error rather than a silent miss.
 */
function collectImports(ctx) {
  const { id, src, mask, where, atStatementStart, deps, edits } = ctx;
  for (const m of mask.matchAll(/\bimport\b/g)) {
    const at = m.index;
    if (!atStatementStart(at)) {
      throw new BuildError(`${where(at)} only \`import { a } from './x.js';\` is supported here — no dynamic import and no import.meta`);
    }
    const semi = mask.indexOf(';', at);
    if (semi === -1) throw new BuildError(`${where(at)} import statement must end with a semicolon`);
    const stmt = src.slice(at, semi + 1);
    const parsed = /^import\s*\{([\s\S]*?)\}\s*from\s*(['"])([^'"]+)\2\s*;$/.exec(stmt);
    if (!parsed) {
      throw new BuildError(`${where(at)} unsupported import form — use \`import { a, b } from './x.js';\``);
    }
    let depId;
    try {
      depId = resolveDep(id, parsed[3]);
    } catch (err) {
      throw new BuildError(`${where(at)} ${err.message}`);
    }
    const bindings = importBindings(parsed[1], where, at);
    deps.push(depId);
    edits.push({ at, end: semi + 1, text: `const { ${bindings.join(', ')} } = require('${depId}');` });
  }
}

/** The export forms this bundler refuses, each with the reason it refuses them. */
function rejectUnsupportedExport(tail, at, where) {
  if (/^\s+default\b/.test(tail)) throw new BuildError(`${where(at)} \`export default\` is not supported — export a named binding`);
  if (/^\s*\{/.test(tail)) throw new BuildError(`${where(at)} export lists are not supported — put \`export\` on the declaration`);
  if (/^\s*\*/.test(tail)) throw new BuildError(`${where(at)} re-exports are not supported`);
}

/** The names one `export` declaration introduces. */
function exportedNames(tail, mask, at, where) {
  // `(?:\s*\*)?` rather than `\s*\*?\s*`: two adjacent `\s*` can split a run of
  // spaces in more than one way, so a near-miss backtracks over every split.
  const fn = /^\s+(?:async\s+)?function(?:\s*\*)?\s*([A-Za-z_$][\w$]*)/.exec(tail);
  if (fn) return [fn[1]];
  const cls = /^\s+class\s+([A-Za-z_$][\w$]*)/.exec(tail);
  if (cls) return [cls[1]];
  const decl = /^\s+(?:const|let|var)\s+/.exec(tail);
  if (!decl) {
    throw new BuildError(`${where(at)} unsupported export form — use \`export const\`, \`export let\`, \`export function\` or \`export class\``);
  }
  const head = at + 6 + decl[0].length;
  const lineEnd = mask.indexOf('\n', head);
  return declaredNames(mask.slice(head, lineEnd === -1 ? mask.length : lineEnd));
}

/** The `export` keyword is dropped and the names it introduced are collected. */
function collectExports(ctx) {
  const { mask, where, atStatementStart, exported, edits } = ctx;
  for (const m of mask.matchAll(/\bexport\b/g)) {
    const at = m.index;
    if (!atStatementStart(at)) throw new BuildError(`${where(at)} \`export\` must start a top-level statement`);
    const tail = mask.slice(at + 6, at + 206);
    rejectUnsupportedExport(tail, at, where);
    exported.push(...exportedNames(tail, mask, at, where));
    const ws = /^\s+/.exec(tail);
    edits.push({ at, end: at + 6 + (ws ? ws[0].length : 0), text: '' });
  }
}

/**
 * Rewrites one module into the body of a registry factory: imports become
 * destructuring `require` calls, `export` keywords are dropped and the exported
 * names are assigned to `exports` at the end.
 */
function parseModule(id, src) {
  const mask = maskCode(src);
  const where = (offset) => `src/${id}:${lineAt(src, offset)}`;
  const edits = [];
  const deps = [];
  const exported = [];

  const atStatementStart = (offset) => {
    const start = mask.lastIndexOf('\n', offset - 1) + 1;
    return mask.slice(start, offset).trim() === '';
  };

  const ctx = { id, src, mask, where, atStatementStart, deps, edits, exported };
  collectImports(ctx);
  collectExports(ctx);

  edits.sort((a, b) => a.at - b.at);
  let body = '';
  let cursor = 0;
  for (const edit of edits) {
    body += src.slice(cursor, edit.at) + edit.text;
    cursor = edit.end;
  }
  body += src.slice(cursor);

  return { id, deps, exported, body: body.trimEnd() };
}

/** One file for the whole background, dependencies first, cycles rejected. */
function bundleBackground(srcDir, version) {
  const modules = new Map();
  const order = [];
  const visiting = [];

  const walk = (id, importer) => {
    if (modules.has(id)) return;
    if (visiting.includes(id)) {
      throw new BuildError(`import cycle: ${[...visiting.slice(visiting.indexOf(id)), id].join(' -> ')}`);
    }
    const file = join(srcDir, ...id.split('/'));
    if (!existsSync(file)) {
      throw new BuildError(importer
        ? `src/${id} does not exist yet — imported by src/${importer}`
        : `src/${id} does not exist yet`);
    }
    const mod = parseModule(id, readFileSync(file, 'utf8'));
    visiting.push(id);
    for (const dep of mod.deps) walk(dep, id);
    visiting.pop();
    modules.set(id, mod);
    order.push(id);
  };
  walk(ENTRY, null);

  const out = [
    `/* Nod Header ${version} — background bundle generated by scripts/build.mjs. Do not edit. */`,
    '(() => {',
    '\'use strict\';',
    '',
    'const M = {};',
    'const D = (id, fn) => { M[id] = { fn, e: null }; };',
    'const R = (id) => {',
    '  const m = M[id];',
    '  if (!m) throw new Error(\'nod-header: unknown module \' + id);',
    '  if (!m.e) { m.e = {}; m.fn(m.e, R); }',
    '  return m.e;',
    '};',
  ];
  for (const id of order) {
    const mod = modules.get(id);
    out.push('', `// ${'─'.repeat(4)} src/${id} ${'─'.repeat(Math.max(4, 68 - id.length))}`);
    out.push(`D('${id}', (exports, require) => {`);
    out.push(mod.body);
    if (mod.exported.length) out.push(`Object.assign(exports, { ${mod.exported.join(', ')} });`);
    out.push('});');
  }
  out.push('', `R('${ENTRY}');`, '})();', '');

  const code = out.join('\n');
  try {
    new Script(code, { filename: 'background/service-worker.js' });
  } catch (err) {
    throw new BuildError(`the bundled background does not parse: ${err.message}`);
  }
  return { code, count: order.length };
}

// ── files ──────────────────────────────────────────────────────────────────

function listFiles(dir, base = dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full, base));
    else found.push(relative(base, full));
  }
  return found.sort();
}

/** Dotfiles are editor and Finder droppings, never part of the extension. */
function copyTree(from, to) {
  let count = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dst, { recursive: true });
      count += copyTree(src, dst);
    } else {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      count += 1;
    }
  }
  return count;
}

function referencedFiles(manifest) {
  const files = new Set();
  const add = (value) => { if (typeof value === 'string' && value) files.add(value); };
  add(manifest.action?.default_popup);
  Object.values(manifest.action?.default_icon ?? {}).forEach(add);
  Object.values(manifest.icons ?? {}).forEach(add);
  add(manifest.options_ui?.page);
  add(manifest.background?.service_worker);
  (manifest.background?.scripts ?? []).forEach(add);
  for (const entry of manifest.web_accessible_resources ?? []) (entry.resources ?? []).forEach(add);
  for (const script of manifest.content_scripts ?? []) {
    (script.js ?? []).forEach(add);
    (script.css ?? []).forEach(add);
  }
  return [...files].sort();
}

function writeManifest(source, distDir, version) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(source, 'utf8'));
  } catch (err) {
    throw new BuildError(`${source} is not valid JSON: ${err.message}`);
  }
  manifest.version = version;
  const out = join(distDir, 'manifest.json');
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(out, 'utf8'));
  } catch (err) {
    throw new BuildError(`the generated manifest does not parse: ${err.message}`);
  }
  const missing = referencedFiles(parsed).filter((rel) => !existsSync(join(distDir, ...rel.split('/'))));
  return { manifest: parsed, missing };
}

// ── zip ────────────────────────────────────────────────────────────────────

/** Zip entries carry a DOS timestamp, two packed 16-bit fields. */
function dosStamp(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function writeZip(dir, zipPath) {
  const stamp = dosStamp(new Date());
  const local = [];
  const central = [];
  let offset = 0;

  for (const rel of listFiles(dir)) {
    const data = readFileSync(join(dir, rel));
    const body = deflateRawSync(data, { level: 9 });
    const name = Buffer.from(rel.split(sep).join('/'), 'utf8');
    const sum = crc32(data);

    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);          // version needed to extract
    head.writeUInt16LE(0, 6);           // no flags
    head.writeUInt16LE(8, 8);           // deflate
    head.writeUInt16LE(stamp.time, 10);
    head.writeUInt16LE(stamp.day, 12);
    head.writeUInt32LE(sum, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);          // no extra field
    local.push(head, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);         // version made by
    entry.writeUInt16LE(20, 6);         // version needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(stamp.time, 12);
    entry.writeUInt16LE(stamp.day, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);         // extra
    entry.writeUInt16LE(0, 32);         // comment
    entry.writeUInt16LE(0, 34);         // disk number
    entry.writeUInt16LE(0, 36);         // internal attributes
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, mode 0644
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += head.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const zip = Buffer.concat([...local, directory, end]);
  writeFileSync(zipPath, zip);
  return zip.length;
}

// ── build ──────────────────────────────────────────────────────────────────

const kb = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;

function buildTarget(target, ctx) {
  const distDir = join(ctx.dist, target);
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  let copied = 0;
  const notes = [];
  for (const dir of COPY_DIRS) {
    const from = join(ctx.src, dir);
    if (!existsSync(from)) {
      notes.push(`src/${dir} does not exist yet — nothing copied`);
      continue;
    }
    mkdirSync(join(distDir, dir), { recursive: true });
    copied += copyTree(from, join(distDir, dir));
  }

  const bundle = bundleBackground(ctx.src, ctx.version);
  const workerPath = join(distDir, ...ENTRY.split('/'));
  mkdirSync(dirname(workerPath), { recursive: true });
  writeFileSync(workerPath, bundle.code);

  const manifestSource = join(ctx.src, `manifest.${target}.json`);
  if (!existsSync(manifestSource)) throw new BuildError(`src/manifest.${target}.json does not exist`);
  const { missing } = writeManifest(manifestSource, distDir, ctx.version);

  let zipped = null;
  if (ctx.zip) {
    const zipPath = join(ctx.dist, `nod-header-${target}-${ctx.version}.zip`);
    zipped = { path: zipPath, size: writeZip(distDir, zipPath) };
  }

  console.log(`${target} -> ${relative(ctx.root, distDir) || distDir}`);
  console.log(`  copied    ${copied} files`);
  console.log(`  bundled   ${ENTRY}  ${kb(Buffer.byteLength(bundle.code))} from ${bundle.count} modules`);
  console.log(`  manifest  manifest.json  version ${ctx.version}${missing.length ? '' : ', every reference resolves'}`);
  if (zipped) console.log(`  zipped    ${relative(ctx.root, zipped.path)}  ${kb(zipped.size)}`);
  for (const note of notes) console.log(`  note      ${note}`);
  for (const rel of missing) console.log(`  MISSING   manifest.json points at ${rel}, which was not built`);

  return missing.length === 0;
}

function ensureIcons(assetsDir) {
  const missing = ICON_SIZES.filter((size) => !existsSync(join(assetsDir, iconName(size))));
  if (!missing.length) return false;
  writeIcons(assetsDir);
  return true;
}

function parseArgs(argv) {
  const args = { targets: TARGETS, zip: false, root: null, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--zip') args.zip = true;
    else if (arg.startsWith('--root=')) args.root = arg.slice(7);
    else if (arg.startsWith('--target=')) {
      const value = arg.slice(9);
      if (value === 'all') args.targets = TARGETS;
      else if (TARGETS.includes(value)) args.targets = [value];
      else throw new BuildError(`unknown target '${value}' — use chrome, firefox or all`);
    } else throw new BuildError(`unknown option '${arg}' — run with --help`);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const root = args.root ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) throw new BuildError(`no package.json in ${root}`);
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(version ?? '')) {
    throw new BuildError(`package.json version '${version}' is not one to four dot-separated numbers, which is all an extension manifest accepts`);
  }

  const ctx = { root, src: join(root, 'src'), dist: join(root, 'dist'), version, zip: args.zip };
  if (!existsSync(ctx.src)) throw new BuildError(`no src directory in ${root}`);
  mkdirSync(ctx.dist, { recursive: true });

  console.log(`Nod Header ${version}`);
  if (ensureIcons(join(ctx.src, 'assets'))) console.log('  icons     generated into src/assets');

  let ok = true;
  for (const target of args.targets) ok = buildTarget(target, ctx) && ok;
  if (!ok) {
    throw new BuildError('the manifest references files that are not built yet — run the build again once they land');
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof BuildError) {
    console.error(`\nBuild failed: ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
