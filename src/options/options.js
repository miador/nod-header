/**
 * Nod Header — options page.
 *
 * Storage is the single source of truth. Every control writes through
 * storage.updateState and the page re-renders from what the write returns, so
 * the popup and this page can never drift apart.
 */
import { api, isGecko } from '../lib/browser.js';
import { MSG, MAX_LOG_LIMIT, MAX_PROFILES, RESOURCE_TYPE_LABELS } from '../lib/constants.js';
import {
  cloneProfile,
  createProfile,
  createSettings,
  createState,
  isHeaderApplicable,
  newId,
  nextProfileColor,
  uniqueProfileName,
} from '../lib/model.js';
import {
  clearLog,
  onLogChanged,
  onStateChanged,
  readLog,
  readState,
  updateState,
  writeState,
} from '../lib/storage.js';
import { patternError } from '../lib/matcher.js';
import { exportPayload, parseImport, serialize, suggestFilename } from '../lib/portable.js';

const SECTIONS = ['general', 'profiles', 'requests', 'about'];
const MIN_LOG_LIMIT = 10;

/** The engine names the background may report, in words a user can read. */
const ENGINE_LABELS = {
  dnr: 'declarativeNetRequest',
  declarativenetrequest: 'declarativeNetRequest',
  'declarative-net-request': 'declarativeNetRequest',
  webrequest: 'Blocking webRequest',
  'web-request': 'Blocking webRequest',
  none: 'None',
  off: 'None',
};

const SOURCE_LABELS = {
  'nod-header': 'Nod Header',
  modheader: 'ModHeader',
  unknown: 'unrecognised',
};

let state = null;
let logEntries = [];
let logView = [];
let logQuery = '';
let toastTimer = 0;

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

// ── small helpers ──────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function count(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function typeLabel(type) {
  return RESOURCE_TYPE_LABELS[type] ?? type;
}

function toast(message, kind) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('toast--error', kind === 'error');
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2400);
}

/** Read-modify-write, then paint from the state the write produced. */
async function edit(mutator) {
  state = await updateState(mutator);
  render();
}

/**
 * The background may key its messages by `type` or accept the bare name, and
 * it may be asleep. Neither case should break the page.
 */
async function send(name) {
  if (!api?.runtime?.sendMessage) return null;
  try {
    const reply = await api.runtime.sendMessage({ type: name });
    if (reply !== undefined && reply !== null) return reply;
  } catch {
    // The worker may key its messages differently; try the bare name.
  }
  try {
    const reply = await api.runtime.sendMessage(name);
    return reply ?? null;
  } catch {
    return null;
  }
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = el('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('Could not copy to the clipboard', 'error');
  }
}

// ── dialogs ────────────────────────────────────────────────────────────

function askConfirm(title, body, okLabel) {
  return new Promise((resolve) => {
    const sheet = $('confirmSheet');
    $('confirmTitle').textContent = title;
    $('confirmBody').textContent = body;
    $('confirmOk').textContent = okLabel;
    sheet.returnValue = '';
    sheet.addEventListener('close', () => resolve(sheet.returnValue === 'ok'), { once: true });
    sheet.showModal();
  });
}

/** Only ask when the user asked to be asked. */
function askDelete(title, body, okLabel) {
  if (!state.settings.confirmDestructive) return Promise.resolve(true);
  return askConfirm(title, body, okLabel);
}

function askName(title, initial) {
  return new Promise((resolve) => {
    const sheet = $('nameSheet');
    const input = $('profileName');
    $('nameTitle').textContent = title;
    input.value = initial;
    sheet.returnValue = '';
    sheet.addEventListener('close', () => {
      resolve(sheet.returnValue === 'save' ? input.value.trim() : null);
    }, { once: true });
    sheet.showModal();
    input.select();
  });
}

// ── theme + routing ────────────────────────────────────────────────────

function applyTheme() {
  const theme = state.settings.theme;
  const dark = theme === 'dark' || (theme === 'system' && systemDark.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', dark ? 'dark' : 'light');
}

function route() {
  const wanted = location.hash.replace('#', '');
  const active = SECTIONS.includes(wanted) ? wanted : SECTIONS[0];
  for (const name of SECTIONS) {
    $(`pane-${name}`).hidden = name !== active;
    const link = $(`nav-${name}`);
    if (name === active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

// ── general ────────────────────────────────────────────────────────────

function renderChrome() {
  const power = $('powerToggle');
  power.checked = state.enabled;
  $('powerText').textContent = state.enabled ? 'Enabled' : 'Paused';
}

function renderGeneral() {
  const settings = state.settings;
  for (const button of $('themeSeg').querySelectorAll('.seg__btn')) {
    const on = button.dataset.val === settings.theme;
    button.setAttribute('aria-checked', String(on));
    button.tabIndex = on ? 0 : -1;
  }
  $('setShowBadge').checked = settings.showBadge;
  $('setConfirmDestructive').checked = settings.confirmDestructive;
  $('setShowTargetTag').checked = settings.showTargetTag;
  $('setLogMatches').checked = settings.logMatches;

  const limit = $('setLogLimit');
  // Leave the box alone while it is being typed into.
  if (document.activeElement !== limit) limit.value = String(settings.logLimit);
}

function setTheme(value) {
  return edit((draft) => { draft.settings.theme = value; }).then(() => toast('Saved'));
}

// ── profiles ───────────────────────────────────────────────────────────

function filterSummary(profile) {
  const parts = [];
  if (profile.include.length === 0) parts.push('Every URL');
  else if (profile.include.length === 1) parts.push(profile.include[0]);
  else parts.push(`${profile.include[0]} and ${profile.include.length - 1} more`);
  if (profile.exclude.length) parts.push(`except ${count(profile.exclude.length, 'pattern', 'patterns')}`);
  if (profile.resourceTypes.length) parts.push(count(profile.resourceTypes.length, 'resource type', 'resource types'));
  if (profile.activeTabOnly) parts.push('active tab only');
  return parts.join(' · ');
}

function filterDetail(profile) {
  const lines = [];
  lines.push(profile.include.length ? `Include: ${profile.include.join(', ')}` : 'Include: every URL');
  if (profile.exclude.length) lines.push(`Exclude: ${profile.exclude.join(', ')}`);
  if (profile.resourceTypes.length) {
    lines.push(`Resource types: ${profile.resourceTypes.map(typeLabel).join(', ')}`);
  }
  if (profile.activeTabOnly) lines.push('Only the tab that is active when the rules are saved');
  return lines.join('\n');
}

/** Every broken pattern in a profile, header patterns included. */
function patternProblems(profile) {
  const problems = [];
  const check = (patterns, label) => {
    for (const pattern of patterns) {
      const message = patternError(pattern);
      if (message) problems.push(`${label} ${pattern} — ${message}`);
    }
  };
  check(profile.include, 'Include');
  check(profile.exclude, 'Exclude');
  for (const header of profile.headers) {
    check(header.include, `${header.name || 'Header'} include`);
  }
  return problems;
}

function renderProfiles() {
  const body = $('profileRows');
  const template = $('profileRowTpl');
  body.textContent = '';

  for (const profile of state.profiles) {
    const row = template.content.firstElementChild.cloneNode(true);
    const isActive = profile.id === state.activeProfileId;
    const enabled = profile.headers.filter((header) => header.enabled).length;
    const applies = profile.headers.filter(isHeaderApplicable).length;

    row.querySelector('.js-color').style.background = profile.color;
    row.querySelector('.js-name').textContent = profile.name;
    row.querySelector('.js-headers').textContent = String(profile.headers.length);

    const on = row.querySelector('.js-on');
    on.textContent = String(enabled);
    on.title = `${count(applies, 'header', 'headers')} will apply`;

    const filters = row.querySelector('.js-filters');
    filters.append(el('span', 'trunc', filterSummary(profile)));
    filters.title = filterDetail(profile);

    row.querySelector('.js-state').append(
      isActive ? el('span', 'pill pill--on', 'Active') : el('span', 'pill', 'Idle'),
    );

    const problems = patternProblems(profile);
    if (problems.length) {
      const warn = row.querySelector('.js-warn');
      const summary = `${count(problems.length, 'pattern needs', 'patterns need')} attention`;
      warn.hidden = false;
      warn.title = `${summary}:\n${problems.join('\n')}`;
      warn.querySelector('.js-warn-text').textContent = summary;
    }

    const activate = row.querySelector('.js-activate');
    activate.disabled = isActive;
    activate.title = isActive ? 'Already active' : 'Make active';
    activate.setAttribute('aria-label', `Make ${profile.name} the active profile`);
    activate.addEventListener('click', () => activateProfile(profile.id));

    const rename = row.querySelector('.js-rename');
    rename.title = 'Rename';
    rename.setAttribute('aria-label', `Rename ${profile.name}`);
    rename.addEventListener('click', () => renameProfile(profile.id));

    const duplicate = row.querySelector('.js-duplicate');
    duplicate.title = 'Duplicate';
    duplicate.setAttribute('aria-label', `Duplicate ${profile.name}`);
    duplicate.disabled = state.profiles.length >= MAX_PROFILES;
    duplicate.addEventListener('click', () => duplicateProfile(profile.id));

    const exportOne = row.querySelector('.js-export');
    exportOne.title = 'Export';
    exportOne.setAttribute('aria-label', `Export ${profile.name}`);
    exportOne.addEventListener('click', () => exportProfiles([profile.id], false));

    const remove = row.querySelector('.js-delete');
    remove.setAttribute('aria-label', `Delete ${profile.name}`);
    remove.disabled = state.profiles.length <= 1;
    remove.title = remove.disabled ? 'Keep at least one profile' : 'Delete';
    remove.addEventListener('click', () => deleteProfile(profile.id));

    body.append(row);
  }

  $('profileCount').textContent = `${count(state.profiles.length, 'profile', 'profiles')} of ${MAX_PROFILES}`;
}

function profileById(id) {
  return state.profiles.find((profile) => profile.id === id) ?? null;
}

async function activateProfile(id) {
  const profile = profileById(id);
  if (!profile) return;
  await edit((draft) => { draft.activeProfileId = id; });
  toast(`${profile.name} is active`);
}

async function renameProfile(id) {
  const profile = profileById(id);
  if (!profile) return;
  const wanted = await askName('Rename profile', profile.name);
  if (!wanted) return;
  await edit((draft) => {
    const target = draft.profiles.find((item) => item.id === id);
    if (target) target.name = uniqueProfileName(draft.profiles, wanted, id);
  });
  toast('Saved');
}

async function duplicateProfile(id) {
  const profile = profileById(id);
  if (!profile) return;
  if (state.profiles.length >= MAX_PROFILES) {
    toast(`You have reached the limit of ${MAX_PROFILES} profiles`, 'error');
    return;
  }
  let name = '';
  await edit((draft) => {
    const source = draft.profiles.find((item) => item.id === id);
    if (!source) return;
    name = uniqueProfileName(draft.profiles, `${source.name} copy`);
    const copy = cloneProfile(source, name);
    // Picked in the mutator, where every other profile's colour is visible.
    copy.color = nextProfileColor(draft.profiles);
    draft.profiles.push(copy);
  });
  toast(`Created ${name}`);
}

async function deleteProfile(id) {
  const profile = profileById(id);
  if (!profile || state.profiles.length <= 1) return;
  const ok = await askDelete(
    'Delete profile?',
    `${profile.name} and its ${count(profile.headers.length, 'header', 'headers')} go for good.`,
    'Delete profile',
  );
  if (!ok) return;
  await edit((draft) => {
    draft.profiles = draft.profiles.filter((item) => item.id !== id);
    if (draft.activeProfileId === id) draft.activeProfileId = draft.profiles[0].id;
  });
  toast(`Deleted ${profile.name}`);
}

function exportProfiles(profileIds, includeSettings) {
  try {
    const options = { profileIds, includeSettings, now: new Date() };
    download(suggestFilename(state, options), serialize(exportPayload(state, options)));
    toast(count(profileIds.length, 'profile exported', 'profiles exported'));
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Export failed', 'error');
  }
}

function reportImport(summary, lines, kind) {
  const box = $('importReport');
  box.textContent = '';
  box.classList.toggle('note--warn', kind === 'warn');
  box.append(el('div', '', summary));
  if (lines.length) {
    const list = el('ul');
    for (const line of lines) list.append(el('li', '', line));
    box.append(list);
  }
  box.hidden = false;
}

async function runImport(file) {
  let parsed = null;
  try {
    parsed = parseImport(await file.text());
  } catch (err) {
    reportImport(err instanceof Error ? err.message : 'That file holds no profiles.', [], 'warn');
    toast('Nothing was imported', 'error');
    return;
  }

  const incoming = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
  const warnings = Array.isArray(parsed?.warnings) ? parsed.warnings.slice() : [];
  if (!incoming.length) {
    reportImport('That file holds no profiles.', warnings, 'warn');
    toast('Nothing was imported', 'error');
    return;
  }

  let takeSettings = false;
  if (parsed.settings) {
    takeSettings = await askConfirm(
      'Import the settings too?',
      'The file carries theme and logging settings. Replace your current settings with them, or choose Cancel to import only the profiles.',
      'Replace settings',
    );
  }

  const added = [];
  let skipped = 0;
  await edit((draft) => {
    for (const candidate of incoming) {
      if (draft.profiles.length >= MAX_PROFILES) {
        skipped += 1;
        continue;
      }
      const profile = createProfile({
        ...candidate,
        id: newId(),
        name: uniqueProfileName(draft.profiles, candidate?.name || 'Imported profile'),
      });
      profile.color = nextProfileColor(draft.profiles);
      draft.profiles.push(profile);
      added.push(profile.name);
    }
    if (takeSettings) draft.settings = createSettings(parsed.settings);
  });

  const source = SOURCE_LABELS[parsed.source] ?? 'unrecognised';
  const lines = warnings.slice();
  if (skipped) lines.push(`${count(skipped, 'profile was', 'profiles were')} skipped: the limit of ${MAX_PROFILES} is reached.`);
  if (takeSettings) lines.push('Settings were replaced with the ones in the file.');
  reportImport(
    `Imported ${count(added.length, 'profile', 'profiles')} from a ${source} export. Switch the active profile to use one.`,
    lines,
    lines.length ? 'warn' : 'plain',
  );
  toast(count(added.length, 'profile imported', 'profiles imported'));
}

// ── requests ───────────────────────────────────────────────────────────

/** The log is written by the background; read it defensively. */
function normalizeEntry(raw) {
  const time = Number(raw?.time ?? raw?.timeStamp ?? raw?.at ?? 0);
  const applied = [raw?.headers, raw?.applied].find(Array.isArray) ?? [];
  return {
    raw,
    time: Number.isFinite(time) ? time : 0,
    method: String(raw?.method ?? ''),
    type: String(raw?.type ?? raw?.resourceType ?? ''),
    url: String(raw?.url ?? ''),
    headers: applied.map((header) => ({
      name: String(header?.name ?? ''),
      operation: String(header?.operation ?? header?.op ?? 'set'),
      value: typeof header?.value === 'string' ? header.value : '',
      // Entries written before the log carried a per-header target only name it
      // once, on the entry.
      target: String(header?.target ?? raw?.target ?? ''),
    })),
  };
}

function matchesQuery(entry, query) {
  if (!query) return true;
  if (entry.url.toLowerCase().includes(query)) return true;
  return entry.headers.some((header) => header.name.toLowerCase().includes(query));
}

function formatTime(ms) {
  if (!ms) return '--:--:--';
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString();
}

function appliedCell(headers) {
  const wrap = el('span', 'applied');
  if (!headers.length) {
    wrap.append(el('span', 'applied__none', 'No headers recorded'));
    return wrap;
  }
  for (const header of headers) {
    const row = el('span', 'applied__row');
    if (state.settings.showTargetTag && header.target) {
      row.append(el('span', 'chip chip--target', header.target === 'response' ? 'Res' : 'Req'));
    }
    row.append(el('span', 'applied__name', header.name));
    row.append(el('span', `chip chip--${header.operation}`, header.operation));
    if (header.operation !== 'remove' && header.value) {
      const value = el('span', 'applied__val', header.value);
      value.title = header.value;
      row.append(value);
    }
    wrap.append(row);
  }
  return wrap;
}

function renderLog() {
  const query = logQuery.trim().toLowerCase();
  const all = logEntries.map(normalizeEntry).sort((a, b) => b.time - a.time);
  logView = all.filter((entry) => matchesQuery(entry, query));

  const body = $('logRows');
  const template = $('logRowTpl');
  body.textContent = '';

  for (const entry of logView) {
    const row = template.content.firstElementChild.cloneNode(true);
    const time = row.querySelector('.js-time');
    time.textContent = formatTime(entry.time);
    if (entry.time) time.title = new Date(entry.time).toLocaleString();
    row.querySelector('.js-method').textContent = entry.method || 'GET';
    row.querySelector('.js-type').textContent = entry.type ? typeLabel(entry.type) : 'Other';
    const url = row.querySelector('.js-url');
    url.textContent = entry.url;
    url.title = entry.url;
    row.querySelector('.js-applied').append(appliedCell(entry.headers));
    body.append(row);
  }

  $('logTable').hidden = logView.length === 0;
  $('logEmpty').hidden = all.length !== 0;
  $('logNoMatch').hidden = !(all.length !== 0 && logView.length === 0);
  $('logCount').textContent = query
    ? `${logView.length} of ${count(all.length, 'entry', 'entries')}`
    : count(all.length, 'entry', 'entries');
  $('logOffNotice').hidden = state.settings.logMatches;
}

/**
 * The background batches log writes for up to half a second, and its GET_LOG
 * handler flushes that queue before answering, so asking it is the only way to
 * see a request that was matched a moment ago. A sleeping or older worker that
 * does not answer costs nothing: storage still holds everything already
 * flushed.
 */
async function loadLog() {
  const reply = await send(MSG.GET_LOG);
  const entries = [reply?.entries, reply].find(Array.isArray) ?? null;
  logEntries = entries ?? await readLog();
}

async function clearRequestLog() {
  await send(MSG.CLEAR_LOG);
  await clearLog();
  logEntries = [];
  renderLog();
  toast('Log cleared');
}

// ── about ──────────────────────────────────────────────────────────────

function engineLabel(value) {
  if (!value) return null;
  const key = String(value).toLowerCase();
  return ENGINE_LABELS[key] ?? String(value);
}

function ruleCountOf(report) {
  if (Array.isArray(report.rules)) return report.rules.length;
  for (const key of ['ruleCount', 'rules', 'totalRules']) {
    if (typeof report[key] === 'number') return report[key];
  }
  const size = (value, fallback) => {
    if (Array.isArray(value)) return value.length;
    return typeof fallback === 'number' ? fallback : null;
  };
  const dynamic = size(report.dynamic, report.dynamicRules ?? report.dynamicRuleCount);
  const session = size(report.session, report.sessionRules ?? report.sessionRuleCount);
  if (dynamic === null && session === null) return null;
  return (dynamic ?? 0) + (session ?? 0);
}

async function loadDiagnostics() {
  $('aboutEngine').textContent = 'Reading...';
  $('aboutRules').textContent = 'Reading...';
  const reply = await send(MSG.GET_DIAGNOSTICS);
  // The worker wraps its answer in { diagnostics }; accept a bare report too.
  const report = reply?.diagnostics ?? reply;
  if (!report || typeof report !== 'object') {
    $('aboutEngine').textContent = 'Unavailable';
    $('aboutRules').textContent = 'Unavailable';
    $('aboutWarnings').hidden = true;
    return;
  }

  const engine = report.engineLabel || engineLabel(report.engine ?? report.engineName ?? report.mode);
  $('aboutEngine').textContent = engine ?? 'Unavailable';
  const rules = ruleCountOf(report);
  $('aboutRules').textContent = rules === null ? 'Unavailable' : String(rules);

  const errors = Array.isArray(report.errors) ? report.errors : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const notes = [...errors, ...warnings];
  const box = $('aboutWarnings');
  box.textContent = '';
  if (notes.length) {
    box.append(el('div', '', errors.length
      ? 'The background could not apply every rule:'
      : 'Some rules were not applied as written:'));
    const list = el('ul');
    for (const note of notes) {
      list.append(el('li', '', typeof note === 'string' ? note : JSON.stringify(note)));
    }
    box.append(list);
  }
  box.hidden = notes.length === 0;
}

async function loadShortcuts() {
  const list = $('aboutShortcuts');
  list.textContent = '';
  let commands;
  try {
    commands = (await api.commands?.getAll?.()) ?? [];
  } catch {
    commands = [];
  }
  if (!commands.length) {
    list.append(el('li', '', 'This build declares no keyboard shortcut.'));
    return;
  }
  for (const command of commands) {
    const item = el('li');
    item.append(el('span', 'kbd', command.shortcut || 'Not set'));
    item.append(el('span', '', command.description || command.name || 'Command'));
    list.append(item);
  }
}

function loadAbout() {
  const manifest = api?.runtime?.getManifest?.();
  $('aboutVersion').textContent = manifest?.version ?? 'Unknown';
  $('shortcutUrl').textContent = isGecko ? 'about:addons' : 'chrome://extensions/shortcuts';
  $('permWebRequestTerm').hidden = !isGecko;
  $('permWebRequestDesc').hidden = !isGecko;
  loadShortcuts();
  loadDiagnostics();
}

async function resetEverything() {
  const ok = await askConfirm(
    'Restore defaults?',
    'Every profile and header goes, the request log is cleared and the settings return to their starting values. This cannot be undone.',
    'Restore defaults',
  );
  if (!ok) return;
  state = await writeState(createState());
  await clearLog();
  logEntries = [];
  logQuery = '';
  $('logFilter').value = '';
  $('importReport').hidden = true;
  render();
  toast('Defaults restored');
}

// ── wiring ─────────────────────────────────────────────────────────────

function render() {
  applyTheme();
  renderChrome();
  renderGeneral();
  renderProfiles();
  renderLog();
}

/** Which way an arrow key moves the selection inside a segmented control. */
const ARROW_STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

function bindGeneral() {
  /**
   * The master switch goes through the worker, which applies the rules before it
   * answers. A bare storage write would report 'Headers are off' while the rules
   * are still installed, because the worker applies them on a debounce. A worker
   * that cannot answer falls back to the write.
   */
  $('powerToggle').addEventListener('change', async (event) => {
    const on = event.currentTarget.checked;
    let reply;
    try {
      reply = await api.runtime.sendMessage({ type: MSG.SET_ENABLED, enabled: on });
    } catch {
      reply = null;
    }
    if (reply?.state) {
      state = reply.state;
      render();
    } else {
      await edit((draft) => { draft.enabled = on; });
    }
    toast(on ? 'Headers are on' : 'Headers are off');
  });

  const seg = $('themeSeg');
  seg.addEventListener('click', (event) => {
    const button = event.target.closest('.seg__btn');
    if (button) setTheme(button.dataset.val);
  });
  seg.addEventListener('keydown', (event) => {
    const step = ARROW_STEP[event.key] ?? 0;
    if (!step) return;
    event.preventDefault();
    const buttons = [...seg.querySelectorAll('.seg__btn')];
    const index = buttons.findIndex((button) => button.getAttribute('aria-checked') === 'true');
    const next = buttons[(index + step + buttons.length) % buttons.length];
    next.focus();
    setTheme(next.dataset.val);
  });

  const flags = [
    ['setShowBadge', 'showBadge'],
    ['setConfirmDestructive', 'confirmDestructive'],
    ['setShowTargetTag', 'showTargetTag'],
    ['setLogMatches', 'logMatches'],
  ];
  for (const [id, key] of flags) {
    $(id).addEventListener('change', (event) => {
      const on = event.currentTarget.checked;
      edit((draft) => { draft.settings[key] = on; }).then(() => toast('Saved'));
    });
  }

  const limit = $('setLogLimit');
  limit.min = String(MIN_LOG_LIMIT);
  limit.max = String(MAX_LOG_LIMIT);
  limit.step = '10';
  limit.addEventListener('change', () => {
    const asked = Number.parseInt(limit.value, 10);
    const next = Number.isFinite(asked)
      ? Math.min(Math.max(asked, MIN_LOG_LIMIT), MAX_LOG_LIMIT)
      : state.settings.logLimit;
    limit.value = String(next);
    edit((draft) => { draft.settings.logLimit = next; }).then(() => toast(`Log holds ${next} entries`));
  });
}

function bindProfiles() {
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (event) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (file) runImport(file);
  });
  $('exportAllBtn').addEventListener('click', () => {
    exportProfiles(state.profiles.map((profile) => profile.id), true);
  });
}

function bindRequests() {
  $('logFilter').addEventListener('input', (event) => {
    logQuery = event.currentTarget.value;
    renderLog();
  });
  $('clearLogBtn').addEventListener('click', clearRequestLog);
  $('copyLogBtn').addEventListener('click', () => {
    if (!logView.length) {
      toast('There is nothing to copy');
      return;
    }
    copyText(
      `${JSON.stringify(logView.map((entry) => entry.raw), null, 2)}\n`,
      count(logView.length, 'entry copied', 'entries copied'),
    );
  });
  $('enableLogBtn').addEventListener('click', () => {
    edit((draft) => { draft.settings.logMatches = true; }).then(() => toast('Logging is on'));
  });
}

function bindAbout() {
  $('refreshDiagnostics').addEventListener('click', loadDiagnostics);
  $('copyShortcutUrl').addEventListener('click', () => {
    copyText($('shortcutUrl').textContent, 'Address copied');
  });
  $('resetBtn').addEventListener('click', resetEverything);
}

function bindShell() {
  for (const button of document.querySelectorAll('dialog .js-close')) {
    button.addEventListener('click', (event) => event.currentTarget.closest('dialog').close());
  }
  window.addEventListener('hashchange', route);
  systemDark.addEventListener('change', () => {
    if (state?.settings.theme === 'system') applyTheme();
  });
}

async function init() {
  state = await readState();
  render();
  route();
  bindShell();
  bindGeneral();
  bindProfiles();
  bindRequests();
  bindAbout();
  loadAbout();

  await loadLog();
  renderLog();

  onStateChanged((next) => {
    state = next;
    render();
  });
  onLogChanged((entries) => {
    logEntries = Array.isArray(entries) ? entries : [];
    renderLog();
  });
}

init().catch((err) => {
  console.error('[nod-header] options failed to start:', err);
});
