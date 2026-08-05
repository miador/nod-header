/**
 * What the browser actually puts on the wire.
 *
 * The unit tests decide what rules the compiler should produce. This file
 * decides whether a real browser, running the real build, changes a real
 * request — the one thing no amount of unit testing can answer. Every assertion
 * is made against a server that recorded what arrived, not against the
 * extension's own account of itself.
 *
 * Pick the browser with NOD_BROWSER=chrome|edge|firefox. A browser that is not
 * installed skips instead of failing, so this runs on a laptop with one browser
 * and on a runner with three.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startProbeServer } from './harness/probe-server.js';
import { launch, plan, REPO_ROOT, wantedEngine } from './harness/launch.js';
import {
  API, applyState, diagnostics, header, oneHeader, profile, state,
} from './harness/extension.js';

const chosen = plan();
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const engine = wantedEngine();
const engineNote = engine === 'auto' ? '' : ` on the ${engine} engine`;
const title = `wire behaviour in ${chosen.spec?.label ?? 'a browser'}${engineNote}`;

if (chosen.skip) console.log(`# skipped: ${chosen.skip}`);

// CI asks for a specific browser, so "it was not installed" has to fail rather
// than skip: a green run that tested nothing is worse than a red one.
if (chosen.skip && process.env.NOD_REQUIRE_BROWSER === '1') {
  it('the browser this run requires is installed', () => {
    assert.fail(chosen.skip);
  });
}

describe(title, { skip: chosen.skip, concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof launch>>} */
  let browser;
  /** @type {Awaited<ReturnType<typeof startProbeServer>>} */
  let probe;

  /** A glob covering one probe path, which is what the UI would take. */
  const scopeOf = (path) => `${probe.origin}${path}*`;

  before(async () => {
    probe = await startProbeServer();
    browser = await launch(chosen.spec, chosen.extensionDir);
    console.log(`# ${browser.name} ${browser.version}, extension ${browser.extensionId}`);
  });

  after(async () => {
    await browser?.close();
    await probe?.close();
  });

  it('installs, boots a background engine, and ships the version in package.json', async () => {
    const report = await diagnostics(browser);
    assert.ok(report, 'the background worker did not answer a diagnostics request');
    assert.deepEqual(report.errors, [], 'the engine reported errors on a clean start');
    assert.notEqual(report.engine, 'none', 'no engine in this browser can modify headers');
    assert.ok(
      report.capabilities.declarativeNetRequest || report.capabilities.blockingWebRequest,
      `no header-modifying capability: ${JSON.stringify(report.capabilities)}`,
    );
    if (engine === 'webrequest') {
      // The run asked for the fallback; if the browser handed us the declarative
      // engine anyway, every assertion below would be testing the wrong code.
      assert.equal(report.engine, 'webRequest', 'this run was meant to exercise the fallback engine');
    }

    const manifest = await browser.evalInExtension(`${API}.runtime.getManifest()`);
    assert.equal(manifest.version, pkg.version, 'the built manifest and package.json disagree');
    assert.equal(manifest.name, 'Nod Header');
  });

  it('leaves a request alone when no header is configured', async () => {
    await applyState(browser, state(), { expect: (d) => d.ruleCount === 0 });

    probe.clear();
    await browser.navigate(probe.url('/bare'));
    const hit = await probe.waitForPath('/bare');

    assert.equal(hit.has('x-nod-main'), false);
    // The baseline for the removal test below: this header is one the browser
    // sends on its own, so its absence there means the rule did the work.
    assert.ok(hit.has('accept-language'), 'this browser did not send accept-language at all');
  });

  it('sends a request header on a top-level page load', async () => {
    await applyState(
      browser,
      oneHeader({ name: 'X-Nod-Main', value: 'main-frame' }),
      { expect: (d) => d.ruleCount > 0 },
    );

    probe.clear();
    await browser.navigate(probe.url('/bare'));
    const hit = await probe.waitForPath('/bare');

    // main_frame is the case a rule with no explicit resourceTypes silently
    // misses, and a top-level load is the first thing a user tries.
    assert.equal(hit.get('x-nod-main'), 'main-frame');
  });

  it('sends it on subresources as well as the document', async () => {
    await applyState(
      browser,
      oneHeader({ name: 'X-Nod-Sub', value: 'every-type' }),
      { expect: (d) => d.ruleCount > 0 },
    );

    probe.clear();
    await browser.navigate(probe.url('/page'));

    for (const path of ['/page', '/probe.css', '/probe.js', '/probe.json']) {
      const hit = await probe.waitForPath(path);
      assert.equal(hit.get('x-nod-sub'), 'every-type', `${path} did not carry the header`);
    }
  });

  it('sends nothing while the master switch is off', async () => {
    const paused = oneHeader({ name: 'X-Nod-Paused', value: 'should-not-appear' });
    paused.enabled = false;

    await applyState(browser, paused, { expect: (d) => d.enabled === false && d.ruleCount === 0 });

    probe.clear();
    await browser.navigate(probe.url('/bare'));
    const hit = await probe.waitForPath('/bare');

    assert.equal(hit.has('x-nod-paused'), false, 'a paused profile still modified the request');
  });

  it('ignores a row whose own switch is off', async () => {
    await applyState(
      browser,
      oneHeader({ name: 'X-Nod-Row', value: 'should-not-appear', enabled: false }),
      { expect: (d) => d.headerCount === 0 && d.ruleCount === 0 },
    );

    probe.clear();
    await browser.navigate(probe.url('/bare'));
    assert.equal((await probe.waitForPath('/bare')).has('x-nod-row'), false);
  });

  it('applies only inside the profile URL scope', async () => {
    await applyState(browser, state({
      profiles: [profile({
        include: [scopeOf('/bare')],
        headers: [header({ name: 'X-Nod-Scope', value: 'in-scope' })],
      })],
    }), { expect: (d) => d.ruleCount > 0 });

    probe.clear();
    await browser.navigate(probe.url('/bare'));
    assert.equal((await probe.waitForPath('/bare')).get('x-nod-scope'), 'in-scope');

    await browser.navigate(probe.url('/other'));
    assert.equal(
      (await probe.waitForPath('/other')).has('x-nod-scope'),
      false,
      'a URL outside the scope was modified anyway',
    );
  });

  it('skips a URL the profile excludes', async () => {
    await applyState(browser, state({
      profiles: [profile({
        exclude: [scopeOf('/other')],
        headers: [header({ name: 'X-Nod-Excluded', value: 'everywhere-but-other' })],
      })],
    }), { expect: (d) => d.ruleCount > 0 });

    probe.clear();
    await browser.navigate(probe.url('/bare'));
    assert.equal((await probe.waitForPath('/bare')).get('x-nod-excluded'), 'everywhere-but-other');

    await browser.navigate(probe.url('/other'));
    assert.equal(
      (await probe.waitForPath('/other')).has('x-nod-excluded'),
      false,
      'an excluded URL was modified anyway',
    );
  });

  it('removes a header the browser would otherwise have sent', async () => {
    await applyState(
      browser,
      oneHeader({ name: 'Accept-Language', value: '', operation: 'remove' }),
      { expect: (d) => d.ruleCount > 0 },
    );

    probe.clear();
    await browser.navigate(probe.url('/bare'));
    const hit = await probe.waitForPath('/bare');

    assert.equal(hit.has('accept-language'), false, 'accept-language survived a remove rule');
  });

  it('appends to a header the browser already sends', async () => {
    await applyState(
      browser,
      oneHeader({ name: 'Accept-Language', value: 'zz-ZZ', operation: 'append' }),
      { expect: (d) => d.ruleCount > 0 },
    );

    probe.clear();
    await browser.navigate(probe.url('/bare'));
    const value = (await probe.waitForPath('/bare')).get('accept-language');

    assert.ok(value?.includes('zz-ZZ'), `appended value is missing from ${JSON.stringify(value)}`);
    assert.ok(
      value.replace('zz-ZZ', '').replace(/[\s,]/g, '').length > 0,
      `append replaced the browser's own value instead of adding to it: ${JSON.stringify(value)}`,
    );
  });

  it('adds a response header the page can read', async () => {
    await applyState(
      browser,
      oneHeader({ name: 'X-Nod-Response', value: 'from-the-extension', target: 'response' }),
      { expect: (d) => d.ruleCount > 0 },
    );

    probe.clear();
    await browser.navigate(probe.url('/bare'));
    await probe.waitForPath('/bare');

    // Same origin as the page, so every response header is readable without any
    // help from CORS.
    const seen = await browser.evalInPage(
      `fetch('/probe.json', { cache: 'no-store' }).then((r) => r.headers.get('x-nod-response'))`,
    );
    assert.equal(seen, 'from-the-extension');
  });

  it('applies the active profile and not the others', async () => {
    const alpha = profile({ name: 'alpha', headers: [header({ name: 'X-Nod-Alpha', value: 'a' })] });
    const beta = profile({ name: 'beta', headers: [header({ name: 'X-Nod-Beta', value: 'b' })] });
    const both = { profiles: [alpha, beta] };

    await applyState(browser, state({ ...both, activeProfileId: alpha.id }), { expect: (d) => d.ruleCount > 0 });
    probe.clear();
    await browser.navigate(probe.url('/bare'));
    let hit = await probe.waitForPath('/bare');
    assert.equal(hit.get('x-nod-alpha'), 'a');
    assert.equal(hit.has('x-nod-beta'), false, 'an inactive profile was applied');

    await applyState(browser, state({ ...both, activeProfileId: beta.id }), { expect: (d) => d.ruleCount > 0 });
    probe.clear();
    await browser.navigate(probe.url('/bare'));
    hit = await probe.waitForPath('/bare');
    assert.equal(hit.get('x-nod-beta'), 'b');
    assert.equal(hit.has('x-nod-alpha'), false, 'the previous profile was still applied');
  });

  it('never logged an error from any extension context', () => {
    // Chromium reports this over the DevTools console feed; Gecko has no
    // equivalent here, so on Firefox this asserts the empty list it started with
    // and the diagnostics assertions above carry the weight.
    assert.deepEqual(browser.problems, []);
  });
});
