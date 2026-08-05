/**
 * Popup — the fast path: switch profile, edit the headers of the active one,
 * and see whether they reach the tab in front of you.
 *
 * State is read and written straight through lib/storage.js, never through the
 * background, so the popup and the options page stay in step through one
 * storage subscription. The background is only asked for diagnostics.
 */
import { api } from '../lib/browser.js';
import {
  MSG,
  MAX_HEADERS_PER_PROFILE,
  MAX_PROFILES,
  RESOURCE_TYPES,
  RESOURCE_TYPE_LABELS,
  COMMON_HEADERS,
  COMMON_HEADER_GROUPS,
  COMMON_HEADER_VALUES,
  CUSTOM_HEADER_OPTION,
} from '../lib/constants.js';
import {
  cloneProfile,
  countApplicableHeaders,
  createHeader,
  createProfile,
  getActiveProfile,
  headerProblem,
  isHeaderApplicable,
  isUnmodifiableHeader,
  isValidHeaderName,
  newId,
  nextProfileColor,
  uniqueProfileName,
} from '../lib/model.js';
import { onStateChanged, readState, updateState } from '../lib/storage.js';
import {
  compilePattern,
  effectiveInclude,
  isRe2Safe,
  patternError,
  urlMatchesFilters,
} from '../lib/matcher.js';
import { exportPayload, parseImport, serialize, suggestFilename } from '../lib/portable.js';

/* ── elements ────────────────────────────────────────────────────────── */

const el = (id) => document.getElementById(id);

const powerToggle = el('powerToggle');
const powerText = el('powerText');
const openOptions = el('openOptions');
const profileSelect = el('profileSelect');
const importBtn = el('importBtn');
const importFile = el('importFile');
const exportBtn = el('exportBtn');
const moreBtn = el('moreBtn');
const profileMenu = el('profileMenu');
const rowsEl = el('rows');
const emptyEl = el('empty');
const rowTpl = el('rowTpl');
const addHeaderBtn = el('addHeader');
const bulkbar = el('bulkbar');
const bulkCount = el('bulkCount');
const statusDot = el('statusDot');
const statusText = el('statusText');
const viewMatched = el('viewMatched');
const scopeBtn = el('scopeBtn');
const toastEl = el('toast');

const headerNameMenu = el('headerNameMenu');
const dlHeaderNames = el('dlHeaderNames');
const dlHeaderValues = el('dlHeaderValues');

const headerSheet = el('headerSheet');
const headerForm = el('headerForm');
const hdName = el('hdName');
const hdValue = el('hdValue');
const hdTarget = el('hdTarget');
const hdOperation = el('hdOperation');
const hdComment = el('hdComment');
const hdInclude = el('hdInclude');
const hdResourceTypes = el('hdResourceTypes');
const hdHint = el('hdHint');

const filterSheet = el('filterSheet');
const filterForm = el('filterForm');
const flScope = el('flScope');
const flLede = el('flLede');
const flInclude = el('flInclude');
const flExclude = el('flExclude');
const flResourceTypes = el('flResourceTypes');
const flActiveTabOnly = el('flActiveTabOnly');
const flHint = el('flHint');

const nameSheet = el('nameSheet');
const nameForm = el('nameForm');
const nameTitle = el('nameTitle');
const profileName = el('profileName');
const nameSave = el('nameSave');

const confirmSheet = el('confirmSheet');
const confirmTitle = el('confirmTitle');
const confirmBody = el('confirmBody');
const confirmOk = el('confirmOk');

/* ── local state ─────────────────────────────────────────────────────── */

/** The value of the dropdown entry that creates a profile instead of picking one. */
const NEW_PROFILE_VALUE = 'fx-new-profile';
const EDIT_DEBOUNCE_MS = 150;
const TOAST_MS = 2400;

let state = null;
let appliedJson = '';

/** Header selection lives only as long as the popup is open. */
const selection = new Set();
let selectionProfileId = null;

/** id -> row element, so a re-render reuses nodes and keeps focus alive. */
const rowById = new Map();
const idOfRow = new WeakMap();

let tabUrl = '';
let diagnostic = '';

/** The status line the worker built, and the state it was built from. */
let workerStatus = null;
let workerStamp = '';

let selectSignature = '';
let toastTimer = 0;

const pendingEdits = new Map();
let editTimer = 0;

let mutateChain = Promise.resolve();
let sheetHeaderId = null;
let nameMode = 'new';
let armedRow = null;
let markedRow = null;
let dragId = null;

/** The row whose header-name picker is open, if any. */
let pickerRowId = null;

/* ── state plumbing ──────────────────────────────────────────────────── */

/**
 * One serialised path for every write. Two bare updateState() calls can both
 * read the cache before either writes, which loses the first edit.
 */
function mutate(fn) {
  const run = mutateChain.then(() => updateState(fn)).then((next) => {
    applyState(next);
    return next;
  });
  mutateChain = run.catch((err) => {
    console.error('[nod-header] popup write failed:', err);
  });
  return run;
}

/** Skip the render when the incoming state is what we already painted. */
function applyState(next) {
  const json = JSON.stringify(next);
  state = next;
  if (json === appliedJson) return;
  appliedJson = json;
  render();
}

const settings = () => state.settings;
const activeProfile = () => getActiveProfile(state);
const activeIn = (draft) => getActiveProfile(draft);

function findHeader(id) {
  const profile = activeProfile();
  return profile ? profile.headers.find((h) => h.id === id) ?? null : null;
}

function findHeaderIn(draft, id) {
  const profile = activeIn(draft);
  return profile ? profile.headers.find((h) => h.id === id) ?? null : null;
}

/**
 * The master switch goes through the worker, which applies the rules before it
 * answers. A bare storage write would let the popup say Paused while headers are
 * still going out, because the worker's storage subscription applies rules on a
 * debounce. A worker that cannot answer falls back to that write, so the UI
 * never waits on a dead worker.
 */
async function setEnabled(enabled) {
  let reply;
  try {
    reply = await api.runtime.sendMessage({ type: MSG.SET_ENABLED, enabled });
  } catch {
    reply = null;
  }
  if (reply?.state) {
    applyState(reply.state);
    loadDiagnostics();
    return;
  }
  await mutate((draft) => { draft.enabled = enabled; });
}

/* ── small helpers ───────────────────────────────────────────────────── */

const lines = (text) => String(text).split('\n').map((s) => s.trim()).filter(Boolean);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function showToast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle('toast--error', isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, TOAST_MS);
}

function setHint(hint, message) {
  hint.querySelector('span').textContent = message || '';
  hint.hidden = !message;
}

function firstPatternError(patterns) {
  for (const pattern of patterns) {
    let problem;
    try {
      problem = patternError(pattern);
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    if (problem) return `${pattern} — ${problem}`;
  }
  // A pattern the browser will refuse is worth saying here rather than leaving
  // the header to go quietly inert: Chrome matches with RE2, which has no
  // lookaround and no backreferences.
  for (const pattern of patterns) {
    const compiled = compilePattern(pattern);
    if (compiled.kind !== 'regex' || !compiled.source) continue;
    if (isRe2Safe(compiled.source)) continue;
    return `${pattern} — the browser cannot match lookahead, lookbehind or a backreference. `
      + 'Rewrite it without them, or use a glob or a bare host.';
  }
  return null;
}

function openSheet(sheet) {
  if (!sheet.open) sheet.showModal();
}

/** Reusable confirm, resolved from the dialog's close value. */
function ask({ title, body, ok }) {
  confirmTitle.textContent = title;
  confirmBody.textContent = body;
  confirmOk.textContent = ok;
  return new Promise((resolve) => {
    confirmSheet.addEventListener('close', () => resolve(confirmSheet.returnValue === 'ok'), { once: true });
    confirmSheet.returnValue = '';
    openSheet(confirmSheet);
  });
}

/** Confirm only when the user asked to be asked. */
function askDestructive(options) {
  if (!settings().confirmDestructive) return Promise.resolve(true);
  return ask(options);
}

/* ── theme ───────────────────────────────────────────────────────────── */

const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const wanted = settings().theme;
  const dark = wanted === 'dark' || (wanted === 'system' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // Without this the UA-drawn parts — the select's dropdown, the scrollbar, the
  // datalist popups, the dialog backdrop — stay light inside a dark panel.
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', dark ? 'dark' : 'light');
}

/* ── typing: debounced writes ────────────────────────────────────────── */

function queueEdit(id, field, value) {
  const patch = pendingEdits.get(id) ?? {};
  patch[field] = value;
  pendingEdits.set(id, patch);
  clearTimeout(editTimer);
  editTimer = setTimeout(flushEdits, EDIT_DEBOUNCE_MS);
}

function flushEdits() {
  clearTimeout(editTimer);
  editTimer = 0;
  if (!pendingEdits.size) return Promise.resolve(state);
  const edits = [...pendingEdits];
  pendingEdits.clear();
  return mutate((draft) => {
    for (const [id, patch] of edits) {
      const header = findHeaderIn(draft, id);
      if (header) Object.assign(header, patch);
    }
  });
}

/* ── rendering ───────────────────────────────────────────────────────── */

function render() {
  const focus = captureFocus();
  applyTheme();
  renderPower();
  renderProfileSelect();
  renderRows();
  renderBulkbar();
  renderStatus();
  restoreFocus(focus);
}

function renderPower() {
  powerToggle.checked = state.enabled;
  powerText.textContent = state.enabled ? 'Enabled' : 'Paused';
}

function renderProfileSelect() {
  const signature = state.profiles.map((p) => `${p.id}\u0000${p.name}`).join('\u0001');
  if (signature !== selectSignature) {
    selectSignature = signature;
    profileSelect.textContent = '';
    for (const profile of state.profiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.name;
      profileSelect.append(option);
    }
    const create = document.createElement('option');
    create.value = NEW_PROFILE_VALUE;
    create.textContent = 'New profile…';
    profileSelect.append(create);
  }
  profileSelect.value = state.activeProfileId;
}

function renderRows() {
  const profile = activeProfile();
  const headers = profile ? profile.headers : [];

  if (profile && profile.id !== selectionProfileId) {
    selectionProfileId = profile.id;
    selection.clear();
  }
  for (const id of [...selection]) {
    if (!headers.some((h) => h.id === id)) selection.delete(id);
  }

  headers.forEach((header, index) => {
    let row = rowById.get(header.id);
    if (!row) {
      row = rowTpl.content.firstElementChild.cloneNode(true);
      rowById.set(header.id, row);
      idOfRow.set(row, header.id);
    }
    paintRow(row, header);
    if (rowsEl.children[index] !== row) {
      rowsEl.insertBefore(row, rowsEl.children[index] ?? null);
    }
  });

  const live = new Set(headers.map((h) => h.id));
  for (const [id, row] of [...rowById]) {
    if (live.has(id)) continue;
    row.remove();
    rowById.delete(id);
  }

  // The picker floats over a row; it cannot outlive one.
  if (pickerRowId && !live.has(pickerRowId)) closePicker();

  emptyEl.hidden = headers.length > 0;
}

function paintRow(row, header) {
  const nameEl = row.querySelector('.js-name');
  const valueEl = row.querySelector('.js-value');
  const pending = pendingEdits.get(header.id);

  // Never write over the field the user is typing in, nor over an edit that is
  // still waiting on the debounce — the field is ahead of storage, not behind.
  const keepName = document.activeElement === nameEl || (pending && 'name' in pending);
  const keepValue = document.activeElement === valueEl || (pending && 'value' in pending);
  if (!keepName && nameEl.value !== header.name) nameEl.value = header.name;
  if (!keepValue && valueEl.value !== header.value) valueEl.value = header.value;

  row.querySelector('.js-enabled').checked = header.enabled;
  row.classList.toggle('row--off', !header.enabled);

  const selected = selection.has(header.id);
  row.querySelector('.js-select').checked = selected;
  row.classList.toggle('row--selected', selected);

  paintValidity(row, header);
  paintTag(row, header);
}

/** The header as it looks right now, including characters not yet written. */
function draftOf(row, header) {
  return {
    ...header,
    name: row.querySelector('.js-name').value,
    value: row.querySelector('.js-value').value,
  };
}

function paintValidity(row, header) {
  const nameEl = row.querySelector('.js-name');
  const valueEl = row.querySelector('.js-value');
  const draft = draftOf(row, header);
  const problem = headerProblem(draft);
  const onName = !!problem && (!isValidHeaderName(draft.name) || isUnmodifiableHeader(draft.name));

  nameEl.classList.toggle('field--invalid', onName);
  valueEl.classList.toggle('field--invalid', !!problem && !onName);
  nameEl.title = onName ? problem : '';
  valueEl.title = problem && !onName ? problem : '';
}

function tagText(header) {
  const parts = [];
  if (header.target === 'response') parts.push('RES');
  if (header.operation !== 'set') parts.push(header.operation.toUpperCase());
  return parts.join(' ');
}

function paintTag(row, header, nameFocused) {
  const tag = row.querySelector('.js-tag');
  const text = settings().showTargetTag ? tagText(header) : '';
  const busy = nameFocused ?? document.activeElement === row.querySelector('.js-name');
  tag.textContent = text;
  // The tag sits on top of the name field, so it yields while that field is live.
  tag.hidden = !text || busy;
}

function renderBulkbar() {
  bulkCount.textContent = String(selection.size);
  bulkbar.hidden = selection.size === 0;
}

function hostLabel(url) {
  try {
    return new URL(url).host || 'this tab';
  } catch {
    return 'this tab';
  }
}

/**
 * A header carries its own include list, and the rule compiler and the log both
 * read that one before the profile's, so the footer has to ask the same question
 * per header rather than once per profile.
 */
function matchesActiveTab(profile) {
  if (!tabUrl || !profile) return false;
  try {
    return profile.headers.filter(isHeaderApplicable).some(
      (header) => urlMatchesFilters(tabUrl, effectiveInclude(header, profile), profile.exclude),
    );
  } catch (err) {
    console.error('[nod-header] pattern match failed:', err);
    return false;
  }
}

/** The master switch and the active profile decide what the status says, so a
 *  snapshot taken before either changed no longer describes this popup. */
const statusStamp = (s) => `${s.enabled ? '1' : '0'}\u0000${s.activeProfileId}`;

function renderStatus() {
  const profile = activeProfile();
  const worker = workerStatus && workerStamp === statusStamp(state) ? workerStatus : null;
  let mode = 'idle';
  // Every branch of the chain below sets `lead`, so there is nothing to default
  // it to. `mode` and `host` do have branches that leave them alone.
  let lead;
  let host = '';

  if (worker && worker.state !== 'on') {
    // The worker knows what the popup cannot see: which engine is live, and
    // whether the last rule update failed.
    mode = worker.state;
    lead = worker.text;
  } else if (!state.enabled) {
    mode = 'paused';
    lead = 'Paused — no headers are being sent';
  } else if (countApplicableHeaders(state) === 0) {
    lead = 'No headers to send';
  } else if (!worker && diagnostic) {
    // No usable status came back, so fall back to the rule report: the worker
    // could not install every rule and the profile is not fully live.
    mode = 'error';
    lead = diagnostic;
  } else if (matchesActiveTab(profile)) {
    mode = 'on';
    lead = 'Rules active for ';
    host = hostLabel(tabUrl);
  } else {
    lead = 'No rules match ';
    host = hostLabel(tabUrl);
  }

  statusDot.dataset.state = mode;
  statusText.textContent = lead;
  if (host) {
    const strong = document.createElement('b');
    strong.textContent = host;
    statusText.append(strong);
  }
}

/* ── focus across a re-render ────────────────────────────────────────── */

const FOCUS_PARTS = ['js-name', 'js-value', 'js-select', 'js-enabled', 'js-edit', 'js-delete', 'grip'];

function captureFocus() {
  const node = document.activeElement;
  if (!node || !rowsEl.contains(node)) return null;
  const row = node.closest('.row');
  const id = row ? idOfRow.get(row) : null;
  if (!id) return null;
  const part = FOCUS_PARTS.find((cls) => node.classList.contains(cls));
  if (!part) return null;
  const text = part === 'js-name' || part === 'js-value';
  return { id, part, start: text ? node.selectionStart : null, end: text ? node.selectionEnd : null };
}

function restoreFocus(focus) {
  if (!focus) return;
  const row = rowById.get(focus.id);
  if (!row) return;
  const node = row.querySelector(`.${focus.part}`);
  if (!node) return;
  if (document.activeElement !== node) node.focus({ preventScroll: true });
  if (typeof focus.start === 'number' && node.setSelectionRange) {
    node.setSelectionRange(focus.start, focus.end ?? focus.start);
  }
}

/* ── header rows: edit, toggle, select, delete ───────────────────────── */

async function addHeader() {
  await flushEdits();
  const profile = activeProfile();
  if (profile.headers.length >= MAX_HEADERS_PER_PROFILE) {
    showToast(`A profile holds up to ${MAX_HEADERS_PER_PROFILE} headers. Remove one to add another.`, true);
    return;
  }
  const header = createHeader();
  await mutate((draft) => { activeIn(draft).headers.push(header); });
  const row = rowById.get(header.id);
  if (row) row.querySelector('.js-name').focus();
}

async function deleteHeader(id) {
  await flushEdits();
  const header = findHeader(id);
  if (!header) return;
  const label = header.name || 'this header';
  const ok = await askDestructive({
    title: 'Remove header',
    body: `${label} will be removed from this profile.`,
    ok: 'Remove',
  });
  if (!ok) return;
  selection.delete(id);
  await mutate((draft) => {
    const profile = activeIn(draft);
    profile.headers = profile.headers.filter((h) => h.id !== id);
  });
}

async function moveHeader(id, delta) {
  await flushEdits();
  await mutate((draft) => {
    const headers = activeIn(draft).headers;
    const from = headers.findIndex((h) => h.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= headers.length) return;
    const [header] = headers.splice(from, 1);
    headers.splice(to, 0, header);
  });
}

function onRowsInput(event) {
  const node = event.target;
  const isName = node.classList.contains('js-name');
  if (!isName && !node.classList.contains('js-value')) return;
  const row = node.closest('.row');
  const id = row ? idOfRow.get(row) : null;
  if (!id) return;
  const header = findHeader(id);
  if (header) paintValidity(row, header);
  queueEdit(id, isName ? 'name' : 'value', node.value);
  // The picker is this field's suggestion list, so it narrows as the field is
  // typed into rather than sitting over it showing every name. Repositioning
  // matters: fewer entries is a shorter menu, which may now fit below the field
  // where the full list had to flip above it.
  if (isName && pickerOpen() && pickerRowId === id) {
    filterPicker(node.value);
    placeMenu(headerNameMenu, node, 'start');
  }
}

function onRowsChange(event) {
  const node = event.target;
  const row = node.closest('.row');
  const id = row ? idOfRow.get(row) : null;
  if (!id) return;

  if (node.classList.contains('js-enabled')) {
    const enabled = node.checked;
    row.classList.toggle('row--off', !enabled);
    mutate((draft) => {
      const header = findHeaderIn(draft, id);
      if (header) header.enabled = enabled;
    });
    return;
  }

  if (node.classList.contains('js-select')) {
    if (node.checked) selection.add(id); else selection.delete(id);
    row.classList.toggle('row--selected', node.checked);
    renderBulkbar();
  }
}

function onRowsClick(event) {
  const row = event.target.closest('.row');
  const id = row ? idOfRow.get(row) : null;
  if (!id) return;
  if (event.target.closest('.js-name-menu')) {
    if (pickerOpen() && pickerRowId === id) closePicker(true);
    else openPicker(row);
  } else if (event.target.classList.contains('js-name')) {
    // Clicking the field opens the same picker the chevron does, but leaves the
    // caret alone: this click is also how the user positions it. Already-open
    // stays open, because a second click is a click into the text, not a toggle.
    if (!(pickerOpen() && pickerRowId === id)) openPicker(row, { focusList: false });
  } else if (event.target.closest('.js-edit')) openHeaderSheet(id);
  else if (event.target.closest('.js-delete')) deleteHeader(id);
}

/** The two fields a row edits in place. */
function isEditField(node) {
  return node.classList.contains('js-name') || node.classList.contains('js-value');
}

/** Alt+Arrow reorders the row rather than moving the caret. */
function handleRowReorder(event, id) {
  if (!event.altKey) return false;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
  event.preventDefault();
  moveHeader(id, event.key === 'ArrowUp' ? -1 : 1);
  return true;
}

/**
 * With the caret still in the field, the arrow keys are the only way into the
 * list, so the field forwards them rather than moving the caret.
 */
function handlePickerArrow(event, node, id) {
  if (!node.classList.contains('js-name') || !pickerOpen() || pickerRowId !== id) return false;
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
  event.preventDefault();
  moveMenuFocus(headerNameMenu, event.key === 'ArrowDown' ? 1 : -1);
  return true;
}

/**
 * Enter on a field that narrowed to exactly one name takes it — the obvious
 * reading of typing "x-api" and pressing Enter. Anything else closes the picker
 * and lets the edit flush.
 */
function takeOnlyMatch() {
  const only = [...headerNameMenu.querySelectorAll('.menu__item:not([hidden])')]
    .filter((item) => item.dataset.value !== CUSTOM_HEADER_OPTION);
  if (only.length === 1) {
    chooseHeaderName(only[0].dataset.value);
    return true;
  }
  closePicker();
  return false;
}

function handleRowEnter(event, node, id) {
  if (event.key !== 'Enter' || !isEditField(node)) return;
  event.preventDefault();
  if (node.classList.contains('js-name') && pickerOpen() && pickerRowId === id
    && takeOnlyMatch()) {
    return;
  }
  flushEdits();
}

function onRowsKeyDown(event) {
  const node = event.target;
  const row = node.closest?.('.row');
  const id = row ? idOfRow.get(row) : null;
  if (!id) return;
  if (handleRowReorder(event, id)) return;
  if (handlePickerArrow(event, node, id)) return;
  handleRowEnter(event, node, id);
}

/**
 * `document.activeElement` is unreliable while focusout is dispatching, so the
 * tag state comes from the event instead of from the document.
 */
function onRowsFocusShift(event) {
  const node = event.target;
  const row = node.closest?.('.row');
  const id = row ? idOfRow.get(row) : null;
  if (!id) return;
  const header = findHeader(id);
  if (header) paintTag(row, header, event.type === 'focusin' && node === row.querySelector('.js-name'));
  // The value suggestions belong to whichever header this row names.
  if (event.type === 'focusin' && node.classList.contains('js-value')) {
    fillValueSuggestions(row.querySelector('.js-name').value);
  }
  if (event.type === 'focusout' && isEditField(node)) flushEdits();
}

/* ── drag and drop reordering ────────────────────────────────────────── */

function clearDropMarks() {
  if (markedRow) markedRow.classList.remove('row--drop-before', 'row--drop-after');
  markedRow = null;
}

function disarmDrag() {
  if (armedRow) armedRow.draggable = false;
  armedRow = null;
}

function onRowsPointerDown(event) {
  const grip = event.target.closest('.grip');
  const row = grip ? grip.closest('.row') : null;
  if (!row) return;
  disarmDrag();
  armedRow = row;
  row.draggable = true;
}

function onDragStart(event) {
  const row = event.target.closest?.('.row');
  if (!row || row !== armedRow) return;
  dragId = idOfRow.get(row) ?? null;
  if (!dragId) return;
  row.classList.add('row--dragging');
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragId);
  }
}

function dropSideOf(row, clientY) {
  const box = row.getBoundingClientRect();
  return clientY > box.top + box.height / 2 ? 'after' : 'before';
}

function onDragOver(event) {
  if (!dragId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const row = event.target.closest?.('.row');
  clearDropMarks();
  if (!row || idOfRow.get(row) === dragId) return;
  row.classList.add(`row--drop-${dropSideOf(row, event.clientY)}`);
  markedRow = row;
}

function onDrop(event) {
  if (!dragId) return;
  event.preventDefault();
  const row = event.target.closest?.('.row');
  const targetId = row ? idOfRow.get(row) : null;
  const side = row ? dropSideOf(row, event.clientY) : 'before';
  const movedId = dragId;
  clearDropMarks();
  if (!targetId || targetId === movedId) return;
  flushEdits().then(() => mutate((draft) => {
    const headers = activeIn(draft).headers;
    const from = headers.findIndex((h) => h.id === movedId);
    let to = headers.findIndex((h) => h.id === targetId);
    if (from < 0 || to < 0) return;
    const [header] = headers.splice(from, 1);
    if (from < to) to -= 1;
    if (side === 'after') to += 1;
    headers.splice(to, 0, header);
  }));
}

function onDragEnd() {
  const row = dragId ? rowById.get(dragId) : null;
  if (row) row.classList.remove('row--dragging');
  dragId = null;
  clearDropMarks();
  disarmDrag();
}

/* ── bulk bar ────────────────────────────────────────────────────────── */

async function runBulk(action) {
  await flushEdits();
  const ids = [...selection];
  if (!ids.length) return;

  if (action === 'clear') {
    selection.clear();
    render();
    return;
  }

  if (action === 'delete') {
    const ok = await askDestructive({
      title: 'Remove headers',
      body: `${plural(ids.length, 'header')} will be removed from this profile.`,
      ok: 'Remove',
    });
    if (!ok) return;
    selection.clear();
    await mutate((draft) => {
      const profile = activeIn(draft);
      profile.headers = profile.headers.filter((h) => !ids.includes(h.id));
    });
    return;
  }

  if (action === 'duplicate') {
    const profile = activeProfile();
    const room = MAX_HEADERS_PER_PROFILE - profile.headers.length;
    if (room <= 0) {
      showToast(`A profile holds up to ${MAX_HEADERS_PER_PROFILE} headers. Remove one to add another.`, true);
      return;
    }
    const copied = Math.min(room, ids.length);
    selection.clear();
    await mutate((draft) => {
      const headers = activeIn(draft).headers;
      let left = room;
      for (let i = headers.length - 1; i >= 0; i -= 1) {
        if (left <= 0) break;
        if (!ids.includes(headers[i].id)) continue;
        headers.splice(i + 1, 0, createHeader({ ...headers[i], id: newId() }));
        left -= 1;
      }
    });
    if (copied < ids.length) showToast(`Duplicated ${plural(copied, 'header')}, the rest hit the profile limit.`);
    return;
  }

  const enabled = action === 'enable';
  await mutate((draft) => {
    for (const header of activeIn(draft).headers) {
      if (ids.includes(header.id)) header.enabled = enabled;
    }
  });
}

/* ── profiles ────────────────────────────────────────────────────────── */

async function selectProfile(id) {
  await flushEdits();
  await mutate((draft) => {
    if (draft.profiles.some((p) => p.id === id)) draft.activeProfileId = id;
  });
}

function openNameSheet(mode) {
  nameMode = mode;
  const profile = activeProfile();
  nameTitle.textContent = mode === 'rename' ? 'Rename profile' : 'New profile';
  nameSave.textContent = mode === 'rename' ? 'Save name' : 'Create profile';
  profileName.value = mode === 'rename' ? profile.name : '';
  openSheet(nameSheet);
  profileName.focus();
  profileName.select();
}

async function saveProfileName() {
  const wanted = profileName.value;
  if (nameMode === 'rename') {
    const id = state.activeProfileId;
    await mutate((draft) => {
      const profile = draft.profiles.find((p) => p.id === id);
      if (profile) profile.name = uniqueProfileName(draft.profiles, wanted, id);
    });
    showToast('Profile renamed');
    return;
  }
  if (state.profiles.length >= MAX_PROFILES) {
    showToast(`You can keep ${MAX_PROFILES} profiles. Delete one to add another.`, true);
    return;
  }
  const created = createProfile({ name: wanted });
  await mutate((draft) => {
    created.name = uniqueProfileName(draft.profiles, wanted);
    created.color = nextProfileColor(draft.profiles);
    draft.profiles.push(created);
    draft.activeProfileId = created.id;
  });
  showToast('Profile created');
  const row = rowById.get(created.headers[0]?.id);
  if (row) row.querySelector('.js-name').focus();
}

async function duplicateProfile() {
  await flushEdits();
  if (state.profiles.length >= MAX_PROFILES) {
    showToast(`You can keep ${MAX_PROFILES} profiles. Delete one to add another.`, true);
    return;
  }
  const source = activeProfile();
  await mutate((draft) => {
    const copy = cloneProfile(source, uniqueProfileName(draft.profiles, `${source.name} copy`));
    copy.color = nextProfileColor(draft.profiles);
    draft.profiles.push(copy);
    draft.activeProfileId = copy.id;
  });
  showToast('Profile duplicated');
}

async function deleteProfile() {
  await flushEdits();
  if (state.profiles.length <= 1) return;
  const profile = activeProfile();
  const ok = await askDestructive({
    title: 'Delete profile',
    body: `${profile.name} and its ${plural(profile.headers.length, 'header')} will be deleted.`,
    ok: 'Delete',
  });
  if (!ok) return;
  await mutate((draft) => {
    const index = draft.profiles.findIndex((p) => p.id === profile.id);
    if (index < 0) return;
    draft.profiles.splice(index, 1);
    const next = draft.profiles[Math.min(index, draft.profiles.length - 1)];
    if (next) draft.activeProfileId = next.id;
  });
  showToast('Profile deleted');
}

async function clearHeaders() {
  await flushEdits();
  const profile = activeProfile();
  if (!profile.headers.length) return;
  const ok = await askDestructive({
    title: 'Remove all headers',
    body: `All ${plural(profile.headers.length, 'header')} in ${profile.name} will be removed.`,
    ok: 'Remove all',
  });
  if (!ok) return;
  selection.clear();
  await mutate((draft) => { activeIn(draft).headers = []; });
  showToast('Headers removed');
}

async function sortHeaders() {
  await flushEdits();
  await mutate((draft) => {
    activeIn(draft).headers.sort((a, b) => {
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      if (an < bn) return -1;
      return an > bn ? 1 : 0;
    });
  });
  showToast('Headers sorted by name');
}

async function copyProfileJson() {
  await flushEdits();
  const profile = activeProfile();
  const text = serialize(exportPayload(state, { profileIds: [profile.id], includeSettings: false }));
  try {
    await navigator.clipboard.writeText(text);
    showToast('Profile copied as JSON');
  } catch {
    showToast('Copying to the clipboard failed. Use Export to save a file instead.', true);
  }
}

/* ── import and export ───────────────────────────────────────────────── */

async function exportState() {
  await flushEdits();
  const payload = exportPayload(state, {
    profileIds: state.profiles.map((p) => p.id),
    includeSettings: true,
  });
  const filename = suggestFilename(state, { now: new Date() });
  const url = URL.createObjectURL(new Blob([serialize(payload)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Exported to ${filename}`);
}

async function importFromFile(file) {
  await flushEdits();
  let text;
  try {
    text = await file.text();
  } catch {
    showToast('That file could not be read.', true);
    return;
  }

  let parsed;
  try {
    parsed = parseImport(text);
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), true);
    return;
  }

  const incoming = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  if (!incoming.length) {
    showToast('That file holds no profiles to import.', true);
    return;
  }

  let added = 0;
  let firstId = null;
  await mutate((draft) => {
    for (const raw of incoming) {
      if (draft.profiles.length >= MAX_PROFILES) break;
      const profile = createProfile({ ...raw, id: newId() });
      profile.name = uniqueProfileName(draft.profiles, profile.name);
      profile.color = nextProfileColor(draft.profiles);
      draft.profiles.push(profile);
      added += 1;
      if (!firstId) firstId = profile.id;
    }
    if (firstId) draft.activeProfileId = firstId;
  });

  const parts = [`Imported ${plural(added, 'profile')}${parsed.source === 'modheader' ? ' from ModHeader' : ''}`];
  const skipped = incoming.length - added;
  if (skipped > 0) parts.push(`${skipped} did not fit — the limit is ${MAX_PROFILES} profiles`);
  if (warnings.length) parts.push(warnings.slice(0, 2).join(' '));
  showToast(parts.join('. '));
}

/* ── profile menu ────────────────────────────────────────────────────── */

function menuOpen() {
  return !profileMenu.hidden;
}

/** Anchor a floating panel to an element, flipping above it when it would clip. */
function placeMenu(menu, anchor, align) {
  const box = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const wanted = align === 'start' ? box.left : box.right - width;
  const left = Math.max(8, Math.min(wanted, window.innerWidth - width - 8));
  const below = box.bottom + 6;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, box.top - height - 6) : below;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function openMenu() {
  const only = state.profiles.length <= 1;
  profileMenu.querySelector('[data-act="delete-profile"]').disabled = only;

  profileMenu.hidden = false;
  moreBtn.setAttribute('aria-expanded', 'true');
  placeMenu(profileMenu, moreBtn, 'end');

  const first = profileMenu.querySelector('.menu__item:not(:disabled)');
  if (first) first.focus();
}

function closeMenu(refocus = false) {
  if (!menuOpen()) return;
  profileMenu.hidden = true;
  moreBtn.setAttribute('aria-expanded', 'false');
  if (refocus) moreBtn.focus();
}

function moveMenuFocus(menu, step) {
  // `:not([hidden])` matters once the header picker filters itself: a hidden entry
  // is still focusable, and stepping onto one would scroll the list to a name that
  // is not on screen.
  const items = [...menu.querySelectorAll('.menu__item:not(:disabled):not([hidden])')];
  if (!items.length) return;
  const at = items.indexOf(document.activeElement);
  if (at < 0) {
    items[step > 0 ? 0 : items.length - 1].focus();
    return;
  }
  const next = items[(at + step + items.length) % items.length];
  next.scrollIntoView({ block: 'nearest' });
  next.focus();
}

function runMenuAction(act) {
  closeMenu();
  if (act === 'new-profile') openNameSheet('new');
  else if (act === 'rename-profile') openNameSheet('rename');
  else if (act === 'duplicate-profile') duplicateProfile();
  else if (act === 'filters') openFilterSheet();
  else if (act === 'sort') sortHeaders();
  else if (act === 'copy-json') copyProfileJson();
  else if (act === 'clear-headers') clearHeaders();
  else if (act === 'delete-profile') deleteProfile();
}

/* ── the common header picker ────────────────────────────────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(id, size) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `ic ic--${size}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

/** Autocomplete for free typing: every common name, always available. */
function fillNameSuggestions() {
  dlHeaderNames.textContent = '';
  for (const name of COMMON_HEADERS) {
    const option = document.createElement('option');
    option.value = name;
    dlHeaderNames.append(option);
  }
}

/** Value autocomplete follows whichever header the row is set to. */
function fillValueSuggestions(name) {
  const values = COMMON_HEADER_VALUES[String(name || '').trim().toLowerCase()] ?? [];
  dlHeaderValues.textContent = '';
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    dlHeaderValues.append(option);
  }
}

function buildHeaderNameMenu() {
  headerNameMenu.textContent = '';
  for (const group of COMMON_HEADER_GROUPS) {
    const label = document.createElement('span');
    label.className = 'menu__group';
    label.textContent = group.label;
    headerNameMenu.append(label);
    for (const name of group.headers) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'menu__item';
      item.setAttribute('role', 'option');
      item.dataset.value = name;
      item.textContent = name;
      headerNameMenu.append(item);
    }
  }

  const custom = document.createElement('button');
  custom.type = 'button';
  custom.className = 'menu__item menu__item--accent';
  custom.setAttribute('role', 'option');
  custom.dataset.value = CUSTOM_HEADER_OPTION;
  custom.append(icon('i-pencil', 16), document.createTextNode('Custom header'));
  headerNameMenu.append(custom);
}

function pickerOpen() {
  return !headerNameMenu.hidden;
}

/**
 * Narrow the picker to the names containing `query`. A group label goes when
 * nothing under it survives, and "Custom header" always stays — it is the way out
 * of the list, so it has to be reachable however little else matches.
 */
function filterPicker(query) {
  const wanted = query.trim().toLowerCase();
  let group = null;
  let matched = false;
  const closeGroup = () => { if (group) group.hidden = !matched; };

  for (const node of headerNameMenu.children) {
    if (node.classList.contains('menu__group')) {
      closeGroup();
      group = node;
      matched = false;
      continue;
    }
    const value = node.dataset.value;
    const custom = value === CUSTOM_HEADER_OPTION;
    const show = custom || !wanted || value.toLowerCase().includes(wanted);
    node.hidden = !show;
    // Custom header sits after the last group rather than inside it, so it must
    // not be what keeps that group's label on screen.
    if (show && !custom) matched = true;
  }
  closeGroup();
}

/**
 * `focusList` is what separates the two ways in. The chevron is a button, so the
 * list takes focus and the arrow keys work immediately. Clicking the field itself
 * has to leave the caret where the user just put it, or they could not type.
 */
function openPicker(row, { focusList = true } = {}) {
  const id = idOfRow.get(row);
  if (!id) return;
  const nameEl = row.querySelector('.js-name');
  const current = nameEl.value.trim().toLowerCase();

  // Opening always shows the whole grouped list; typing is what narrows it.
  filterPicker('');
  for (const item of headerNameMenu.querySelectorAll('.menu__item')) {
    const value = item.dataset.value;
    const on = value !== CUSTOM_HEADER_OPTION && value.toLowerCase() === current;
    item.setAttribute('aria-selected', on ? 'true' : 'false');
  }

  pickerRowId = id;
  headerNameMenu.hidden = false;
  row.querySelector('.js-name-menu').setAttribute('aria-expanded', 'true');
  nameEl.setAttribute('aria-expanded', 'true');
  placeMenu(headerNameMenu, nameEl, 'start');

  const chosen = headerNameMenu.querySelector('.menu__item[aria-selected="true"]')
    ?? headerNameMenu.querySelector('.menu__item:not([hidden])');
  if (chosen) {
    chosen.scrollIntoView({ block: 'center' });
    if (focusList) chosen.focus();
  }
}

function closePicker(refocus = false) {
  if (!pickerOpen()) return;
  const row = pickerRowId ? rowById.get(pickerRowId) : null;
  headerNameMenu.hidden = true;
  pickerRowId = null;
  if (!row) return;
  row.querySelector('.js-name-menu').setAttribute('aria-expanded', 'false');
  const nameEl = row.querySelector('.js-name');
  nameEl.setAttribute('aria-expanded', 'false');
  if (refocus) nameEl.focus();
}

/**
 * Picking a name fills the field. Picking "Custom header" clears it and hands
 * the field back, which is the whole point of the last entry.
 */
function chooseHeaderName(value) {
  const id = pickerRowId;
  const row = id ? rowById.get(id) : null;
  closePicker();
  if (!row || !id) return;

  const nameEl = row.querySelector('.js-name');
  const valueEl = row.querySelector('.js-value');
  const custom = value === CUSTOM_HEADER_OPTION;

  nameEl.value = custom ? '' : value;
  queueEdit(id, 'name', nameEl.value);
  fillValueSuggestions(nameEl.value);

  // Send the cursor wherever there is still something to type.
  if (custom || valueEl.value) nameEl.focus();
  else valueEl.focus();

  const header = findHeader(id);
  if (header) {
    paintValidity(row, header);
    paintTag(row, header, document.activeElement === nameEl);
  }
}

/* ── segmented controls and chips ────────────────────────────────────── */

function buildChips(container) {
  container.textContent = '';
  for (const type of RESOURCE_TYPES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.val = type;
    chip.setAttribute('aria-pressed', 'false');
    chip.textContent = RESOURCE_TYPE_LABELS[type] ?? type;
    container.append(chip);
  }
}

function setChips(container, values) {
  const wanted = new Set(values);
  for (const chip of container.querySelectorAll('.chip')) {
    chip.setAttribute('aria-pressed', wanted.has(chip.dataset.val) ? 'true' : 'false');
  }
}

function readChips(container) {
  return [...container.querySelectorAll('.chip[aria-pressed="true"]')].map((chip) => chip.dataset.val);
}

function setSeg(seg, value) {
  const buttons = [...seg.querySelectorAll('.seg__btn')];
  const known = buttons.some((b) => b.dataset.val === value);
  for (const button of buttons) {
    const on = known ? button.dataset.val === value : button === buttons[0];
    button.setAttribute('aria-checked', on ? 'true' : 'false');
    button.tabIndex = on ? 0 : -1;
  }
}

function readSeg(seg) {
  const on = seg.querySelector('.seg__btn[aria-checked="true"]');
  return (on ?? seg.querySelector('.seg__btn')).dataset.val;
}

function onSegClick(event) {
  const button = event.target.closest('.seg__btn');
  if (!button) return;
  setSeg(event.currentTarget, button.dataset.val);
  updateHeaderHint();
}

/** Which way an arrow key moves the selection inside a segmented control. */
const ARROW_STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

function onSegKeyDown(event) {
  const step = ARROW_STEP[event.key] ?? 0;
  if (!step) return;
  event.preventDefault();
  const seg = event.currentTarget;
  const buttons = [...seg.querySelectorAll('.seg__btn')];
  const at = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
  const next = buttons[(at + step + buttons.length) % buttons.length];
  setSeg(seg, next.dataset.val);
  next.focus();
  updateHeaderHint();
}

/* ── header details sheet ────────────────────────────────────────────── */

async function openHeaderSheet(id) {
  await flushEdits(); // the row may hold characters that are not written yet
  const header = findHeader(id);
  if (!header) return;
  sheetHeaderId = id;
  hdName.value = header.name;
  hdValue.value = header.value;
  hdComment.value = header.comment;
  hdInclude.value = header.include.join('\n');
  setSeg(hdTarget, header.target);
  setSeg(hdOperation, header.operation);
  setChips(hdResourceTypes, header.resourceTypes);
  openSheet(headerSheet);
  updateHeaderHint();
  hdName.focus();
  hdName.select();
}

function sheetDraft() {
  return {
    name: hdName.value.trim(),
    value: hdValue.value,
    target: readSeg(hdTarget),
    operation: readSeg(hdOperation),
    comment: hdComment.value,
    include: lines(hdInclude.value),
    resourceTypes: readChips(hdResourceTypes),
  };
}

function updateHeaderHint() {
  if (!headerSheet.open) return;
  const draft = sheetDraft();
  setHint(hdHint, firstPatternError(draft.include) ?? headerProblem(draft));
}

async function saveHeaderSheet() {
  const id = sheetHeaderId;
  sheetHeaderId = null;
  if (!id) return;
  const patch = sheetDraft();
  await mutate((draft) => {
    const header = findHeaderIn(draft, id);
    if (header) Object.assign(header, createHeader({ ...header, ...patch }));
  });
}

async function deleteHeaderFromSheet() {
  const id = sheetHeaderId;
  sheetHeaderId = null;
  headerSheet.close('cancel');
  if (id) await deleteHeader(id);
}

/* ── profile filters sheet ───────────────────────────────────────────── */

async function openFilterSheet() {
  await flushEdits();
  const profile = activeProfile();
  flInclude.value = profile.include.join('\n');
  flExclude.value = profile.exclude.join('\n');
  flActiveTabOnly.checked = profile.activeTabOnly;
  setChips(flResourceTypes, profile.resourceTypes);
  openSheet(filterSheet);
  renderFilterScope();
  updateFilterHint();
  flInclude.focus();
}

/** An empty include list is what "all sites" means, so the scope reads itself
 *  off the patterns rather than being stored separately. */
function renderFilterScope() {
  const scoped = lines(flInclude.value).length > 0;
  setSeg(flScope, scoped ? 'urls' : 'all');
  flLede.textContent = scoped
    ? 'Only URLs that match an include pattern get these headers. An exclude pattern always wins.'
    : 'Every site gets these headers. Add an exclude pattern to skip one, or switch to specific URLs.';
}

function chooseFilterScope(scope) {
  if (scope === 'all') {
    flInclude.value = '';
  } else {
    if (!lines(flInclude.value).length) {
      const host = tabUrl ? hostLabel(tabUrl) : '';
      flInclude.value = host && host.includes('.') ? `*://${host}/*` : '';
    }
    flInclude.focus();
    flInclude.setSelectionRange(flInclude.value.length, flInclude.value.length);
  }
  renderFilterScope();
  updateFilterHint();
}

function updateFilterHint() {
  if (!filterSheet.open) return;
  setHint(flHint, firstPatternError([...lines(flInclude.value), ...lines(flExclude.value)]));
}

async function saveFilterSheet() {
  const include = lines(flInclude.value);
  const exclude = lines(flExclude.value);
  const resourceTypes = readChips(flResourceTypes);
  const activeTabOnly = flActiveTabOnly.checked;
  await mutate((draft) => {
    const profile = activeIn(draft);
    profile.include = include;
    profile.exclude = exclude;
    profile.resourceTypes = resourceTypes;
    profile.activeTabOnly = activeTabOnly;
  });
  showToast('Filters saved');
}

/* ── background diagnostics ──────────────────────────────────────────── */

async function loadDiagnostics() {
  let snapshot;
  try {
    snapshot = await api.runtime.sendMessage({ type: MSG.GET_SNAPSHOT });
  } catch {
    return; // the worker may still be starting; the footer works without it
  }
  // The worker answers { state, status, diagnostics }: the rule report lives
  // under diagnostics, and status is this footer's line, already decided.
  const diagnostics = snapshot?.diagnostics ?? {};
  const errors = Array.isArray(diagnostics.errors) ? diagnostics.errors : [];
  const warnings = Array.isArray(diagnostics.warnings) ? diagnostics.warnings : [];
  diagnostic = String(errors[0] ?? warnings[0] ?? '');
  const status = snapshot?.status;
  const usable = typeof status?.state === 'string' && typeof status?.text === 'string';
  workerStatus = usable ? status : null;
  workerStamp = snapshot?.state ? statusStamp(snapshot.state) : '';
  if (state) renderStatus();
}

async function loadActiveTab() {
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    tabUrl = tabs?.[0]?.url ?? '';
  } catch {
    tabUrl = '';
  }
  if (state) renderStatus();
}

/* ── wiring ──────────────────────────────────────────────────────────── */

function wire() {
  powerToggle.addEventListener('change', () => { setEnabled(powerToggle.checked); });

  openOptions.addEventListener('click', () => api.runtime.openOptionsPage());

  viewMatched.addEventListener('click', () => {
    api.tabs.create({ url: api.runtime.getURL('options/options.html#requests') });
  });

  profileSelect.addEventListener('change', () => {
    if (profileSelect.value === NEW_PROFILE_VALUE) {
      profileSelect.value = state.activeProfileId;
      openNameSheet('new');
      return;
    }
    selectProfile(profileSelect.value);
  });

  importBtn.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => {
    const file = importFile.files?.[0];
    importFile.value = '';
    if (file) importFromFile(file);
  });
  exportBtn.addEventListener('click', exportState);

  moreBtn.addEventListener('click', () => {
    if (menuOpen()) closeMenu(true); else openMenu();
  });
  profileMenu.addEventListener('click', (event) => {
    const item = event.target.closest('.menu__item');
    if (item && !item.disabled) runMenuAction(item.dataset.act);
  });
  profileMenu.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveMenuFocus(profileMenu, 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveMenuFocus(profileMenu, -1); }
    else if (event.key === 'Tab') closeMenu();
  });

  headerNameMenu.addEventListener('click', (event) => {
    const item = event.target.closest('.menu__item');
    if (item) chooseHeaderName(item.dataset.value);
  });
  headerNameMenu.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveMenuFocus(headerNameMenu, 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveMenuFocus(headerNameMenu, -1); }
    else if (event.key === 'Tab') closePicker();
  });

  document.addEventListener('pointerdown', (event) => {
    if (menuOpen() && !profileMenu.contains(event.target) && !moreBtn.contains(event.target)) {
      closeMenu();
    }
    // The field that owns the open picker is exempt, along with the chevron:
    // pointerdown runs before click, so closing here would shut the picker on
    // every click into its own text and the click handler would reopen it.
    const ownField = pickerRowId
      ? event.target === rowById.get(pickerRowId)?.querySelector('.js-name')
      : false;
    if (pickerOpen() && !headerNameMenu.contains(event.target)
      && !event.target.closest?.('.js-name-menu') && !ownField) {
      closePicker();
    }
  });
  window.addEventListener('blur', () => { closeMenu(); closePicker(); });

  scopeBtn.addEventListener('click', openFilterSheet);

  flScope.addEventListener('click', (event) => {
    const button = event.target.closest('.seg__btn');
    if (button) chooseFilterScope(button.dataset.val);
  });
  flScope.addEventListener('keydown', (event) => {
    const step = ARROW_STEP[event.key] ?? 0;
    if (!step) return;
    event.preventDefault();
    chooseFilterScope(readSeg(flScope) === 'all' ? 'urls' : 'all');
    const on = flScope.querySelector('.seg__btn[aria-checked="true"]');
    if (on) on.focus();
  });

  addHeaderBtn.addEventListener('click', addHeader);

  rowsEl.addEventListener('input', onRowsInput);
  rowsEl.addEventListener('change', onRowsChange);
  rowsEl.addEventListener('click', onRowsClick);
  rowsEl.addEventListener('keydown', onRowsKeyDown);
  rowsEl.addEventListener('focusin', onRowsFocusShift);
  rowsEl.addEventListener('focusout', onRowsFocusShift);
  rowsEl.addEventListener('pointerdown', onRowsPointerDown);
  rowsEl.addEventListener('dragstart', onDragStart);
  rowsEl.addEventListener('dragover', onDragOver);
  rowsEl.addEventListener('drop', onDrop);
  rowsEl.addEventListener('dragend', onDragEnd);
  // A floating panel cannot follow a scrolling row, so it steps aside.
  rowsEl.addEventListener('scroll', () => closePicker(), { passive: true });
  document.addEventListener('pointerup', () => { if (!dragId) disarmDrag(); });

  bulkbar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-bulk]');
    if (button) runBulk(button.dataset.bulk);
  });

  hdTarget.addEventListener('click', onSegClick);
  hdTarget.addEventListener('keydown', onSegKeyDown);
  hdOperation.addEventListener('click', onSegClick);
  hdOperation.addEventListener('keydown', onSegKeyDown);

  for (const chips of [hdResourceTypes, flResourceTypes]) {
    chips.addEventListener('click', (event) => {
      const chip = event.target.closest('.chip');
      if (!chip) return;
      chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    });
  }

  for (const input of [hdName, hdValue, hdInclude]) {
    input.addEventListener('input', updateHeaderHint);
  }
  hdName.addEventListener('input', () => fillValueSuggestions(hdName.value));
  for (const input of [flInclude, flExclude]) {
    input.addEventListener('input', updateFilterHint);
  }
  flInclude.addEventListener('input', renderFilterScope);

  for (const sheet of [headerSheet, filterSheet, nameSheet]) {
    sheet.addEventListener('click', (event) => {
      if (event.target.closest('.js-close')) sheet.close('cancel');
    });
  }
  headerSheet.addEventListener('click', (event) => {
    if (event.target.closest('.js-delete-header')) deleteHeaderFromSheet();
  });
  headerSheet.addEventListener('close', () => { sheetHeaderId = null; });

  headerForm.addEventListener('submit', () => { saveHeaderSheet(); });
  filterForm.addEventListener('submit', () => { saveFilterSheet(); });
  nameForm.addEventListener('submit', () => { saveProfileName(); });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (pickerOpen()) {
      event.preventDefault();
      closePicker(true);
    } else if (menuOpen()) {
      event.preventDefault();
      closeMenu(true);
    }
  });

  darkQuery.addEventListener('change', () => { if (state) applyTheme(); });

  // The popup can vanish mid-keystroke; get the last edit to storage first.
  window.addEventListener('pagehide', () => { flushEdits(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushEdits();
  });

  onStateChanged((next) => {
    applyState(next);
    // A new profile or a changed header gives the worker a different answer.
    loadDiagnostics();
  });
}

/* ── start ───────────────────────────────────────────────────────────── */

async function start() {
  buildChips(hdResourceTypes);
  buildChips(flResourceTypes);
  buildHeaderNameMenu();
  fillNameSuggestions();
  wire();
  state = await readState();
  appliedJson = JSON.stringify(state);
  render();
  loadActiveTab();
  loadDiagnostics();
}

start();
