// Offline tests for diagnose_source_readonly (real index.ts via harness; fake network, DNS and Supabase).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadHandler, call, cleanup, html, redirect, json, TEST_ENV, OPERATOR_ID, OPERATOR_TOKEN, MEMBER_TOKEN } from './harness.mjs';

after(cleanup);

const SOURCE = 'https://ancona.movieland.18tickets.it/';
const HOST = 'ancona.movieland.18tickets.it';
const DNS = { [HOST]: ['93.184.216.40'], 'evil.example': ['93.184.216.99'] };
const OPERATORS = { RADAR_OPERATOR_USER_IDS: OPERATOR_ID };
const ASK = { mode: 'diagnose_source_readonly', source: 'movieland-ancona', today: '2026-10-11' };

// Minimal page in the structure parse18Tickets reads: film links with page-heading titles, schedule-<id>
// sections, dated time-select__place blocks and #theater-init showtime links.
const film = (id, title, blocks) => `
  <a href="/film/${id}/"><h2 class="page-heading">${title}</h2></a>
  <div id="schedule-${id}">${blocks.map(([day, times]) => `
    <div class="time-select__place"><span>${day}</span>${times.map(t => `<a href="${SOURCE}film/${id}/s/1#theater-init">${t}</a>`).join('')}</div>`).join('')}
  </div>`;
const VALID_PAGE = `<html><body>${film(101, 'Mammina', [['Sabato 11/10/2026', ['18:30', '21:15']], ['Domenica 12/10/2026', ['20:00']], ['Lunedì 13/10/2026', ['21:00']]])}${film(202, 'Her Private Hell', [['Sabato 11/10/2026', ['22:40']]])}</body></html>`;
const EMPTY_PAGE = `<html><body>${film(101, 'Mammina', [['Lunedì 20/10/2026', ['21:00']]])}</body></html>`;

function sideEffectsAreZero(state, label) {
  assert.deepEqual(state.tableCalls, [], label + ': no database access');
  assert.deepEqual(state.writes, [], label + ': no database writes');
  assert.ok(!state.clients.some(c => c.key === TEST_ENV.SUPABASE_SERVICE_ROLE_KEY), label + ': service role client never created');
  assert.ok(!state.fetches.some(f => f.href.includes('tavily')), label + ': no Tavily');
}
const hosts = state => [...new Set(state.fetches.map(f => new URL(f.href).hostname))];

test('valid schedule: screenings for today and tomorrow only, with provenance and verification status', async () => {
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html(VALID_PAGE) } });
  const r = await call(s, ASK, { token: OPERATOR_TOKEN });
  assert.equal(r.status, 200);
  const d = r.json;
  assert.deepEqual([d.ok, d.outcome, d.scheduleAcquired], [true, 'schedule_found', true]);
  assert.equal(d.http.contentType, 'text/html');
  assert.equal(d.structure.recognized, true);
  assert.deepEqual(d.protection, { indicators: [], headers: [], suspected: false });
  assert.deepEqual(d.dates, ['2026-10-11', '2026-10-12']);
  assert.deepEqual(d.source, { id: 'movieland-ancona', platform: '18tickets', url: SOURCE });
  assert.deepEqual(d.sideEffects, { databaseAccess: false, tavily: false, published: false });
  assert.deepEqual(d.verification, { schedule: 'as_published_by_source_at_fetchedAt', genre: 'not_verified' });
  assert.equal(d.timezone, 'Europe/Rome');
  assert.equal(d.genreFilter, 'none');
  assert.match(d.scope, /every genre/);
  assert.ok(!Number.isNaN(Date.parse(d.fetchedAt)));
  assert.deepEqual(d.limits, { pages: 1, maxRedirects: 2, timeoutMs: 6500, timeoutCovers: 'request+redirects+body', maxChars: 1500000, protocol: 'https' });
  assert.equal(d.http.status, 200);
  assert.equal(d.http.finalUrl, SOURCE);
  const byKey = Object.fromEntries(d.screenings.map(x => [x.title + '|' + x.date, x.showtimes]));
  assert.deepEqual(byKey, { 'Mammina|2026-10-11': ['18:30', '21:15'], 'Mammina|2026-10-12': ['20:00'], 'Her Private Hell|2026-10-11': ['22:40'] });
  assert.ok(d.screenings.every(x => x.sourceUrl === SOURCE && x.scheduleStatus === 'as_published_by_source' && x.genreStatus === 'not_verified'));
  assert.deepEqual(d.counts, { titles: 2, screenings: 3 });
  assert.equal(s.fetches.length, 1, 'exactly one external request');
  assert.deepEqual(hosts(s), [HOST]);
  sideEffectsAreZero(s, 'valid');
});

test('reachable source without screenings for the dates', async () => {
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html(EMPTY_PAGE) } });
  const d = (await call(s, ASK, { token: OPERATOR_TOKEN })).json;
  assert.equal(d.ok, true);
  assert.deepEqual(d.screenings, []);
  assert.deepEqual(d.counts, { titles: 0, screenings: 0 });
  assert.ok(d.structure.scheduleSections > 0, 'page structure recognised, just nothing scheduled');
  assert.deepEqual([d.outcome, d.scheduleAcquired, d.structure.recognized], ['no_screenings_for_dates', false, true]);
  assert.equal(s.fetches.length, 1);
  sideEffectsAreZero(s, 'empty');
});

test('source answers 403: reported, no retry, nothing else contacted', async () => {
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html('Forbidden', 403) } });
  const r = await call(s, ASK, { token: OPERATOR_TOKEN });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.ok, r.json.outcome, r.json.error, r.json.http.status], [false, 'http_error', 'http_403', 403]);
  assert.deepEqual(r.json.screenings, []);
  assert.equal(s.fetches.length, 1);
  sideEffectsAreZero(s, '403');
});

test('timeout: aborted after the limit and reported', async () => {
  const hang = init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: hang } });
  const started = Date.now();
  const d = (await call(s, ASK, { token: OPERATOR_TOKEN })).json;
  const elapsed = Date.now() - started;
  assert.deepEqual([d.ok, d.error, d.phase], [false, 'timeout', 'request']);
  assert.ok(elapsed >= 6000 && elapsed < 9000, `stopped after ${elapsed} ms`);
  assert.equal(s.fetches.length, 1);
  sideEffectsAreZero(s, 'timeout');
});

// Body helpers: headers arrive at once, then the body stalls, fails or never ends.
const streamed = start => () => new Response(new ReadableStream(start), { status: 200, headers: { 'content-type': 'text/html' } });
const enc = new TextEncoder();

test('body stalls after the headers: the same deadline stops the read, reported as a body timeout', async () => {
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: streamed({ start(c) { c.enqueue(enc.encode('<html><body>')); } }) } });
  const started = Date.now();
  const r = await call(s, ASK, { token: OPERATOR_TOKEN });
  const elapsed = Date.now() - started;
  assert.equal(r.status, 200, 'structured report, not a 502');
  assert.deepEqual([r.json.ok, r.json.error, r.json.phase, r.json.http.status], [false, 'timeout', 'body', 200]);
  assert.ok(elapsed >= 6000 && elapsed < 9000, `whole operation bounded: ${elapsed} ms`);
  assert.equal(s.fetches.length, 1);
  sideEffectsAreZero(s, 'stalled body');
});

test('body fails while being read: reported as body_read_failed, distinct from a timeout', async () => {
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: streamed({ start(c) { c.enqueue(enc.encode('<html>')); c.error(new Error('connection reset')); } }) } });
  const r = await call(s, ASK, { token: OPERATOR_TOKEN });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.ok, r.json.error, r.json.phase], [false, 'body_read_failed', 'body']);
  assert.ok(!r.text.includes('connection reset'), 'internal error text not exposed');
  sideEffectsAreZero(s, 'failing body');
});

test('endless body: reading stops at the size limit, quickly, and is marked truncated', async () => {
  let chunks = 0;
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: streamed({ pull(c) { chunks++; c.enqueue(enc.encode('x'.repeat(65536))); } }) } });
  const started = Date.now();
  const d = (await call(s, ASK, { token: OPERATOR_TOKEN })).json;
  assert.deepEqual([d.ok, d.outcome, d.http.truncated, d.http.chars], [false, 'no_schedule_structure', true, 1500000]);
  assert.ok(chunks <= Math.ceil(1500000 * 4 / 65536) + 2, `stopped pulling after ${chunks} chunks`);
  assert.ok(Date.now() - started < 5000, 'did not wait for the deadline');
  sideEffectsAreZero(s, 'endless body');
});

test('HTTPS only: downgrades to HTTP are refused before being requested, on every hop', async () => {
  const cases = [
    ['https -> http, same host', 'http://' + HOST + '/'],
    ['https -> http, same host, explicit port 80', 'http://' + HOST + ':80/'],
    ['https -> http, same host, port 443', 'http://' + HOST + ':443/'],
    ['https -> http, relative scheme switch', 'http:/' + '/' + HOST + '/it/'],
  ];
  for (const [name, target] of cases) {
    const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: redirect(target), ['http://' + HOST + '/']: html(VALID_PAGE), ['http://' + HOST + '/it/']: html(VALID_PAGE) } });
    const d = (await call(s, ASK, { token: OPERATOR_TOKEN })).json;
    assert.deepEqual([d.ok, d.error, d.phase], [false, 'blocked_destination_not_allowed_for_source', 'request'], name);
    assert.deepEqual(s.fetches.map(f => f.href), [SOURCE], name + ': the HTTP URL was never requested');
    sideEffectsAreZero(s, name);
  }
});

test('unexpected HTML: interstitial page, JSON and oversized page are classified, never reported as ok', async () => {
  const cases = {
    interstitial: [html('<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>'), 'no_schedule_structure', false],
    json: [json({ hello: 'world' }), 'unexpected_content_type', false],
    oversized: [html('<div>' + 'x'.repeat(1_600_000) + '</div>'), 'no_schedule_structure', true],
  };
  for (const [name, [route, outcome, truncated]] of Object.entries(cases)) {
    const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: route } });
    const d = (await call(s, ASK, { token: OPERATOR_TOKEN })).json;
    assert.deepEqual([d.ok, d.outcome, d.scheduleAcquired], [false, outcome, false], name);
    assert.deepEqual(d.screenings, [], name);
    assert.equal(d.structure.scheduleSections, 0, name);
    assert.equal(d.http.truncated, truncated, name);
    if (name === 'interstitial') assert.equal(d.page.title, 'Just a moment...');
    if (name === 'oversized') assert.equal(d.http.chars, 1500000);
    sideEffectsAreZero(s, name);
  }
});

test('redirects: private address and other hosts are refused before being contacted; same-host redirects are bounded', async () => {
  const cases = [
    ['to cloud metadata', redirect('http://169.254.169.254/latest/meta-data/'), 'blocked_private_address', 1],
    ['to localhost', redirect('http://localhost/'), 'blocked_host_not_allowed', 1],
    ['to another public host', redirect('https://evil.example/steal'), 'blocked_destination_not_allowed_for_source', 1],
    ['to the same host on port 8443', redirect('https://' + HOST + ':8443/'), 'blocked_port_not_allowed', 1],
    ['to the same host over HTTPS (allowed)', redirect('/it/'), null, 2],
  ];
  for (const [name, route, error, fetches] of cases) {
    const routes = { [SOURCE]: route, [SOURCE + 'it/']: html(VALID_PAGE) };
    const s = await loadHandler({ env: OPERATORS, dns: DNS, routes });
    const d = (await call(s, ASK, { token: OPERATOR_TOKEN })).json;
    if (error) assert.deepEqual([d.ok, d.error], [false, error], name);
    else assert.deepEqual([d.ok, d.http.finalUrl, d.counts.screenings], [true, SOURCE + 'it/', 3], name);
    assert.equal(s.fetches.length, fetches, name + ': requests made');
    assert.deepEqual(hosts(s), [HOST], name + ': only the source host was contacted');
    sideEffectsAreZero(s, name);
  }
  const loop = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: redirect(SOURCE) } });
  const d = (await call(loop, ASK, { token: OPERATOR_TOKEN })).json;
  assert.deepEqual([d.ok, d.error], [false, 'blocked_too_many_redirects']);
  assert.equal(loop.fetches.length, 3, 'one page + at most 2 redirects');
});

test('only allowlisted sources: unknown source rejected, caller-supplied URL ignored', async () => {
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html(VALID_PAGE) } });
  const unknown = await call(s, { mode: 'diagnose_source_readonly', source: 'https://evil.example/' }, { token: OPERATOR_TOKEN });
  assert.deepEqual([unknown.status, unknown.json.error, unknown.json.allowed], [400, 'unknown_source', ['movieland-ancona']]);
  for (const source of ['__proto__', 'constructor', 'toString', '']) {
    assert.equal((await call(s, { mode: 'diagnose_source_readonly', source }, { token: OPERATOR_TOKEN })).json.error, 'unknown_source', source);
  }
  assert.equal(s.fetches.length, 0);
  const injected = await call(s, { ...ASK, url: 'http://169.254.169.254/' }, { token: OPERATOR_TOKEN });
  assert.equal(injected.json.ok, true);
  assert.deepEqual(s.fetches.map(f => f.href), [SOURCE], 'only the allowlisted URL was requested');
  assert.equal((await call(s, { ...ASK, today: '2026-02-30' }, { token: OPERATOR_TOKEN })).json.error, 'invalid_date');
});

test('unauthorized callers never reach the source', async () => {
  const configured = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html(VALID_PAGE) } });
  assert.equal((await call(configured, ASK)).status, 401);
  assert.equal((await call(configured, ASK, { token: 'sb_publishable_placeholder' })).status, 401);
  assert.equal((await call(configured, ASK, { token: MEMBER_TOKEN })).status, 403);
  const unconfigured = await loadHandler({ dns: DNS, routes: { [SOURCE]: html(VALID_PAGE) } });
  assert.equal((await call(unconfigured, ASK, { token: OPERATOR_TOKEN })).json.error, 'operator_access_not_configured');
  for (const s of [configured, unconfigured]) {
    assert.deepEqual(s.fetches, [], 'source never contacted');
    sideEffectsAreZero(s, 'unauthorized');
  }
});

test('report never contains configured secrets', async () => {
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html(VALID_PAGE) } });
  const text = (await call(s, ASK, { token: OPERATOR_TOKEN })).text;
  for (const secret of Object.values(TEST_ENV)) assert.ok(!text.includes(secret));
  assert.ok(!text.includes(OPERATOR_TOKEN));
});

// ---------------------------------------------------------------- response classification (v3)

test('HTTP 202 is an anomaly, not a schedule and not automatically bot protection', async () => {
  // Even a 202 that carries a perfectly parseable schedule must not be read as one.
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html(VALID_PAGE, 202) } });
  const d = (await call(s, ASK, { token: OPERATOR_TOKEN })).json;
  assert.deepEqual([d.ok, d.outcome, d.scheduleAcquired, d.phase, d.http.status], [false, 'anomalous_status', false, 'response', 202]);
  assert.deepEqual(d.screenings, []);
  assert.deepEqual(d.protection, { indicators: [], headers: [], suspected: false }, 'no protection claimed without evidence');
  assert.equal(d.structure.recognized, true, 'structure is still reported for analysis');
  assert.equal(s.fetches.length, 1);
  sideEffectsAreZero(s, '202 plain');
});

test('HTTP 202 with AWS WAF signals: still anomalous_status, with indicators, header flags and no secret values', async () => {
  const body = '<html><head><title>Human Verification</title><script src="https://abc.token.awswaf.com/abc/challenge.js"></script></head><body><noscript>Please enable JavaScript</noscript></body></html>';
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html(body, 202, { 'x-amzn-waf-action': 'challenge', 'set-cookie': 'aws-waf-token=SECRETCOOKIEVALUE123; Path=/' }) } });
  const r = await call(s, ASK, { token: OPERATOR_TOKEN });
  const d = r.json;
  assert.deepEqual([d.ok, d.outcome, d.scheduleAcquired], [false, 'anomalous_status', false]);
  assert.deepEqual([...d.protection.indicators].sort(), ['aws_waf', 'javascript_required']);
  assert.deepEqual(d.protection.headers, ['x-amzn-waf-action']);
  assert.equal(d.protection.suspected, true);
  assert.deepEqual([d.http.wafAction, d.http.headers['set-cookie'], d.http.headers['x-amzn-waf-action']], ['challenge', true, true]);
  assert.equal(d.page.title, 'Human Verification');
  assert.deepEqual([d.page.signals.scripts, d.page.signals.noscript], [1, true]);
  for (const leak of ['SECRETCOOKIEVALUE123', 'aws-waf-token=', 'token.awswaf.com', 'challenge.js', '<script', '<noscript']) assert.ok(!r.text.includes(leak), 'leaked: ' + leak);
  sideEffectsAreZero(s, '202 waf');
});

test('HTTP 200 verification page (Cloudflare signals) is suspected_protection_page', async () => {
  const body = '<html><head><title>Attention Required</title></head><body><div id="cf-chl-widget"></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></body></html>';
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html(body, 200, { 'cf-mitigated': 'challenge', 'cf-ray': 'abc-MXP' }) } });
  const d = (await call(s, ASK, { token: OPERATOR_TOKEN })).json;
  assert.deepEqual([d.ok, d.outcome, d.scheduleAcquired], [false, 'suspected_protection_page', false]);
  assert.deepEqual(d.protection.indicators, ['cloudflare']);
  assert.deepEqual(d.protection.headers, ['cf-mitigated']);
  assert.equal(d.http.headers['cf-ray'], true, 'informational header reported as presence only');
  assert.match(d.note, /Do not try to bypass/);
  sideEffectsAreZero(s, 'cloudflare');
});

test('a real schedule wins over a generic word like "captcha" on the page', async () => {
  const body = VALID_PAGE.replace('</body>', '<form class="login"><div class="g-recaptcha"></div></form></body>');
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html(body) } });
  const d = (await call(s, ASK, { token: OPERATOR_TOKEN })).json;
  assert.deepEqual([d.ok, d.outcome, d.scheduleAcquired, d.counts.screenings], [true, 'schedule_found', true, 3]);
  assert.deepEqual(d.protection.indicators, ['captcha'], 'indicator still reported for transparency');
});

test('no_screenings_for_dates only with a complete, reliable structure', async () => {
  const sectionOnly = '<html><a href="/film/1/"><h2 class="page-heading">Mammina</h2></a><div id="schedule-1"></div></html>';
  const blocksOnly = '<html><div class="time-select__place">Sabato 11/10/2026</div></html>';
  const noFilmLinks = '<html><div id="schedule-1"><div class="time-select__place">Lunedì 20/10/2026</div></div></html>';
  for (const [name, body] of Object.entries({ sectionOnly, blocksOnly, noFilmLinks })) {
    const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html(body) } });
    const d = (await call(s, ASK, { token: OPERATOR_TOKEN })).json;
    assert.deepEqual([d.ok, d.outcome, d.structure.recognized], [false, 'no_schedule_structure', false], name);
  }
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html(EMPTY_PAGE) } });
  const d = (await call(s, ASK, { token: OPERATOR_TOKEN })).json;
  assert.deepEqual([d.ok, d.outcome, d.structure.recognized], [true, 'no_screenings_for_dates', true], 'complete structure');
});

test('title is cleaned: tags and control characters removed, length capped; content type reduced to the media type', async () => {
  const title = '<b>Movieland</b>\u0000\u0007 Ancona\t\n' + 'x'.repeat(300);
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html('<html><head><title>' + title + '</title></head></html>', 200, { 'content-type': 'text/html; charset=UTF-8' }) } });
  const d = (await call(s, ASK, { token: OPERATOR_TOKEN })).json;
  assert.equal(d.http.contentType, 'text/html');
  assert.ok(d.page.title.startsWith('Movieland Ancona x'), d.page.title.slice(0, 30));
  assert.ok(d.page.title.length <= 120);
  assert.ok(!/[<>\u0000-\u001f]/.test(d.page.title));
});

test('non-2xx responses keep header flags but the body is never read or returned', async () => {
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html('<html>BODY-NOT-TO-RETURN</html>', 503, { 'x-amzn-waf-action': 'block', 'retry-after': '120' }) } });
  const r = await call(s, ASK, { token: OPERATOR_TOKEN });
  assert.deepEqual([r.json.ok, r.json.outcome, r.json.error, r.json.http.wafAction, r.json.http.headers['retry-after']], [false, 'http_error', 'http_503', 'block', true]);
  assert.ok(!r.text.includes('BODY-NOT-TO-RETURN'));
  assert.equal(r.json.page, undefined);
});

test('unknown WAF action values are not echoed back', async () => {
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html('<html></html>', 202, { 'x-amzn-waf-action': 'weird-value-with-data-12345' }) } });
  const r = await call(s, ASK, { token: OPERATOR_TOKEN });
  assert.equal(r.json.http.wafAction, null);
  assert.equal(r.json.http.headers['x-amzn-waf-action'], true);
  assert.ok(!r.text.includes('weird-value-with-data-12345'));
});

test('report size stays small and carries no page markup', async () => {
  const big = '<html><head><title>T</title></head><body><div class="c">' + 'y'.repeat(200) + '</div>' + '<script>var x=1</script>'.repeat(500) + '</body></html>';
  const s = await loadHandler({ env: OPERATORS, dns: DNS, routes: { [SOURCE]: html(big) } });
  const r = await call(s, ASK, { token: OPERATOR_TOKEN });
  assert.ok(r.text.length < 4000, `report ${r.text.length} chars`);
  assert.ok(!r.text.includes('<script') && !r.text.includes('var x=1'));
  assert.equal(r.json.page.signals.scripts, 500);
});
