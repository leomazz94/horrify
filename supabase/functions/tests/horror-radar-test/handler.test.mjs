// End-to-end tests on the real index.ts handler (see harness.mjs): no network, no Supabase.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { OPERATOR_MODES } from '../../horror-radar-test/security.mjs';
import { loadHandler, call, cleanup, html, redirect, json, TEST_ENV, OPERATOR_ID, OPERATOR_TOKEN, MEMBER_TOKEN, ANON_USER_TOKEN } from './harness.mjs';

after(cleanup);

const OPERATORS = { RADAR_OPERATOR_USER_IDS: OPERATOR_ID };
const SERVICE_KEY = TEST_ENV.SUPABASE_SERVICE_ROLE_KEY, ANON_KEY = TEST_ENV.SUPABASE_ANON_KEY;
const TAVILY = 'https://api.tavily.com/search';
const operatorBody = mode => ({ mode, url: 'https://cinema.example.it/', title: 'Mammina' });

function assertNothingHappened(state, label) {
  assert.deepEqual(state.fetches, [], label + ': no outbound request');
  assert.deepEqual(state.clients.filter(c => c.key === SERVICE_KEY), [], label + ': service role client not created');
  assert.deepEqual(state.writes, [], label + ': no database write');
}

test('transport: preflight, method and malformed input are handled before any work', async () => {
  const state = await loadHandler({ env: OPERATORS });
  assert.equal((await call(state, null, { method: 'OPTIONS' })).status, 200);
  assert.equal((await call(state, null, { method: 'GET' })).status, 405);
  assert.equal((await call(state, null, { rawBody: '{oops' })).json.error, 'invalid_json');
  assert.equal((await call(state, null, { rawBody: '[]' })).json.error, 'invalid_body');
  assert.equal((await call(state, null, { rawBody: JSON.stringify({ mode: 'discover_radar', pad: 'x'.repeat(20000) }) })).status, 413);
  assert.deepEqual((await call(state, { mode: 'drop_tables' })), { status: 400, json: { error: 'unknown_mode' }, text: '{"error":"unknown_mode"}' });
  assert.equal((await call(state, { mode: 'discover_radar', lat: 43.6, lon: 13.5, today: '2026-02-30' })).json.error, 'invalid_date');
  assertNothingHappened(state, 'transport');
});

test('every operator mode refuses callers without a session', async () => {
  const state = await loadHandler({ env: OPERATORS });
  for (const mode of OPERATOR_MODES) {
    const res = await call(state, operatorBody(mode));
    assert.deepEqual([res.status, res.json.error], [401, 'operator_auth_required'], mode);
  }
  assertNothingHappened(state, 'no session');
  assert.deepEqual(state.getUserCalls, []);
});

test('API keys (publishable/anon/service) are not sessions', async () => {
  const state = await loadHandler({ env: OPERATORS });
  for (const token of ['sb_publishable_placeholder', 'sb_secret_x', 'not-a-jwt']) {
    const res = await call(state, operatorBody('verify_genre'), { token });
    assert.deepEqual([res.status, res.json.error], [401, 'operator_auth_invalid'], token);
  }
  assert.deepEqual(state.getUserCalls, [], 'never forwarded to Auth');
  assertNothingHappened(state, 'api keys');
});

test('authenticated non-operators and anonymous sessions are refused for every operator mode', async () => {
  const state = await loadHandler({ env: OPERATORS });
  for (const token of [MEMBER_TOKEN, ANON_USER_TOKEN, 'forged.jwt.token']) {
    for (const mode of OPERATOR_MODES) {
      const res = await call(state, operatorBody(mode), { token });
      assert.ok([401, 403].includes(res.status), `${mode} ${token} -> ${res.status}`);
      assert.match(res.json.error, /^operator_/);
    }
  }
  assertNothingHappened(state, 'non-operators');
  assert.ok(state.getUserCalls.length > 0 && state.getUserCalls.every(c => c.key === ANON_KEY), 'sessions validated with the anon key, not the service role');
  assert.ok(state.logs.some(([event]) => event === 'radar_operator_denied'));
});

test('without RADAR_OPERATOR_USER_IDS nobody is an operator', async () => {
  for (const value of [undefined, '', '*', 'all']) {
    const state = await loadHandler({ env: { RADAR_OPERATOR_USER_IDS: value } });
    const res = await call(state, operatorBody('diagnose_18tickets_parser'), { token: OPERATOR_TOKEN });
    assert.deepEqual([res.status, res.json.error], [403, 'operator_access_not_configured'], String(value));
    assertNothingHappened(state, 'unconfigured');
  }
});

test('operators can run offline diagnostics', async () => {
  const state = await loadHandler({ env: OPERATORS });
  const res = await call(state, { mode: 'diagnose_18tickets_parser' }, { token: OPERATOR_TOKEN });
  assert.equal(res.status, 200);
  assert.equal(res.json.diagnostic, '18tickets_parser');
});

test('parse_official_page (operator) cannot reach local, private or metadata addresses', async () => {
  const state = await loadHandler({
    env: OPERATORS,
    dns: { 'rebind.example.com': ['10.0.0.7'], 'cinema.example.it': ['93.184.216.34'] },
    routes: { 'https://cinema.example.it/': redirect('http://169.254.169.254/latest/meta-data/iam/') },
  });
  const cases = {
    'http://169.254.169.254/latest/meta-data/': 'official_page_blocked_private_address',
    'http://127.0.0.1/': 'official_page_blocked_private_address',
    'http://localhost:54321/rest/v1/': 'official_page_blocked_port_not_allowed',
    'http://[::1]/': 'official_page_blocked_private_address',
    'http://2130706433/': 'official_page_blocked_private_address',
    'https://rebind.example.com/': 'official_page_blocked_private_address',
    'https://cinema.example.it/': 'official_page_blocked_private_address',
  };
  for (const [url, detail] of Object.entries(cases)) {
    const res = await call(state, { mode: 'parse_official_page', url }, { token: OPERATOR_TOKEN });
    assert.deepEqual([res.status, res.json.error, res.json.detail], [502, 'radar_failed', detail], url);
  }
  assert.deepEqual(state.fetches.map(f => f.href), ['https://cinema.example.it/'], 'only the public page was contacted; its redirect target never was');
  assert.deepEqual(state.blockedFetches, []);
});

test('fails closed when the runtime cannot resolve DNS', async () => {
  const state = await loadHandler({ env: OPERATORS, noDns: true, routes: { 'https://cinema.example.it/': html('<p>ok</p>') } });
  const res = await call(state, { mode: 'parse_official_page', url: 'https://cinema.example.it/' }, { token: OPERATOR_TOKEN });
  assert.equal(res.json.detail, 'official_page_blocked_dns_resolution_failed');
  assert.deepEqual(state.fetches, []);
});

test('verify_genre writes to the cache only for operators, through the scoped service client', async () => {
  const tavily = json({ results: [] });
  const state = await loadHandler({ env: OPERATORS, routes: { [TAVILY]: tavily } });
  assert.equal((await call(state, { mode: 'verify_genre', title: 'Film Inventato' }, { token: MEMBER_TOKEN })).status, 403);
  assert.deepEqual(state.writes, []);
  const res = await call(state, { mode: 'verify_genre', title: 'Film Inventato' }, { token: OPERATOR_TOKEN });
  assert.equal(res.status, 200);
  assert.deepEqual(state.writes, [{ table: 'radar_movie_classification', op: 'upsert', key: SERVICE_KEY }]);
});

const CINEMA = { name: 'Cinema Test', city: 'Ancona', address: null, latitude: 43.6, longitude: 13.5 };
const horrorEvidence = json({ results: [
  { title: 'Mammina - film horror 2026', url: 'https://a.example/1', content: 'Mammina è un film horror di Rob Savage.' },
  { title: 'Mammina recensione', url: 'https://b.example/2', content: 'Mammina, horror psicologico.' },
] });

test('discover_radar stays public and keeps its behaviour on an official page', async () => {
  const state = await loadHandler({
    tables: { radar_cinemas: [{ ...CINEMA, website: 'https://cinema.example.it/' }] },
    dns: { 'cinema.example.it': ['93.184.216.34'] },
    routes: { 'https://cinema.example.it/': html('<div>Oggi: Mammina 21:00</div>'), [TAVILY]: horrorEvidence },
  });
  const res = await call(state, { mode: 'discover_radar', lat: 43.61, lon: 13.51, radiusKm: 50, today: '2026-10-09' });
  assert.equal(res.status, 200);
  assert.equal(res.json.version, '1.8-official-first');
  assert.equal(res.json.cinemasFound, 1);
  assert.equal(res.json.verifiedResults.length, 1);
  const [hit] = res.json.verifiedResults;
  assert.deepEqual([hit.movieTitle, hit.date, hit.showtimes, hit.sourceType, hit.sourceUrl, hit.verificationWarning],
    ['Mammina', '2026-10-09', ['21:00'], 'official_cinema', 'https://cinema.example.it/', null]);
  assert.deepEqual(state.getUserCalls, [], 'no auth needed');
  assert.ok(state.clients.every(c => c.key === SERVICE_KEY), 'only the scoped service client');
  assert.ok(state.tableCalls.every(c => ['radar_cinemas', 'radar_movie_classification'].includes(c.table)));
  assert.equal(state.fetches.find(f => f.href === 'https://cinema.example.it/').redirect, 'manual');
});

test('discover_radar does not fetch a cinema website that points to a local or private address', async () => {
  const state = await loadHandler({
    tables: { radar_cinemas: [{ ...CINEMA, website: 'http://169.254.169.254/latest/meta-data/' }, { ...CINEMA, name: 'Cinema Due', latitude: 43.62, website: 'http://localhost/' }] },
    routes: { [TAVILY]: json({ results: [] }) },
  });
  const res = await call(state, { mode: 'discover_radar', lat: 43.61, lon: 13.51, today: '2026-10-09' });
  assert.equal(res.status, 200);
  assert.ok(res.json.inspected.every(c => c.officialError === 'official_page_unavailable'));
  assert.ok(state.fetches.every(f => f.href === TAVILY), 'only the fixed Tavily endpoint was contacted');
  assert.ok(state.logs.some(([event, data]) => event === 'radar_destination_blocked' && JSON.parse(data).reason === 'private_address'));
});

test('operator errors carry detail and a request id that is also logged', async () => {
  const state = await loadHandler({ env: OPERATORS });
  const op = await call(state, { mode: 'parse_official_page', url: 'http://127.0.0.1/' }, { token: OPERATOR_TOKEN });
  assert.ok(op.json.detail && op.json.requestId);
  assert.ok(state.logs.some(([event]) => event === 'radar_failed'));
});

test('responses never contain configured secrets', async () => {
  const state = await loadHandler({ env: OPERATORS, routes: { [TAVILY]: json({ results: [] }) } });
  const bodies = [
    await call(state, {}), await call(state, operatorBody('diagnose_tavily')), await call(state, operatorBody('diagnose_tavily'), { token: MEMBER_TOKEN }),
    await call(state, operatorBody('diagnose_tavily'), { token: OPERATOR_TOKEN }), await call(state, { mode: 'parse_official_page', url: 'http://10.0.0.1/' }, { token: OPERATOR_TOKEN }),
  ].map(r => r.text).join('\n');
  for (const secret of [TEST_ENV.SUPABASE_SERVICE_ROLE_KEY, TEST_ENV.SUPABASE_ANON_KEY, TEST_ENV.TAVILY_API_KEY]) assert.ok(!bodies.includes(secret));
});
