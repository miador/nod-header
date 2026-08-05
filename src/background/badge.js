/**
 * The toolbar badge: how many headers the active profile is sending, in that
 * profile's colour, and a title that says what is happening.
 *
 * The badge is never set per tab. Nothing in the state is per tab, and a
 * per-tab override would survive the next global update and go stale.
 */
import { api, guard } from '../lib/browser.js';
import { APP_NAME } from '../lib/constants.js';
import { getActiveProfile, isHeaderApplicable } from '../lib/model.js';

/**
 * The badge has no stylesheet, so these two live here rather than in
 * tokens.css. Slate reads as inactive; white keeps the count legible on every
 * profile colour.
 */
const PAUSED_COLOR = '#5b6b7f';
const BADGE_TEXT_COLOR = '#ffffff';

/** Firefox for Android and old Chrome only expose the browserAction alias. */
function toolbar() {
  return api?.action ?? api?.browserAction ?? null;
}

function titleFor(state, profile, count) {
  const name = profile?.name ?? '';
  if (!state.enabled) {
    return `${APP_NAME} — paused. Turn it back on to send headers again.`;
  }
  if (count === 0) {
    return name
      ? `${APP_NAME} — ${name} has no headers to apply.`
      : `${APP_NAME} — no headers to apply.`;
  }
  const noun = count === 1 ? 'header' : 'headers';
  const where = profile.activeTabOnly ? ' in the active tab' : '';
  return `${APP_NAME} — ${name} is sending ${count} ${noun}${where}.`;
}

/**
 * The count is the headers that would apply, so a paused profile still shows
 * what is waiting — greyed out rather than blank.
 */
export async function refreshBadge(state) {
  const action = toolbar();
  if (!action) return;
  const profile = getActiveProfile(state);
  const count = profile ? profile.headers.filter(isHeaderApplicable).length : 0;
  const show = state.settings?.showBadge !== false;
  const text = show && count > 0 ? String(count) : '';
  const color = state.enabled ? (profile?.color ?? PAUSED_COLOR) : PAUSED_COLOR;

  await guard('refresh badge', async () => {
    await action.setBadgeText({ text });
    await action.setBadgeBackgroundColor({ color });
    if (typeof action.setBadgeTextColor === 'function') {
      await action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
    }
    await action.setTitle({ title: titleFor(state, profile, count) });
  });
}
