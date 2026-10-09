import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMode, parseOperatorIds, authorizeOperator, isValidIsoDate, readJsonBody, readTextCapped,
  isPublicAddress, checkDestinationUrl, createSafeFetch, DestinationBlockedError, restrictTables,
} from '../../horror-radar-test/security.mjs';

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const fakeGetUser = users => async token => (users[token] ? { data: { user: users[token] }, error: null } : { data: { user: null }, error: { message: 'bad' } });

test('modes: only registered modes are routable, diagnostics are operator-only', () => {
  assert.deepEqual(classifyMode(undefined), { mode: 'status', access: 'public' });
  assert.deepEqual(classifyMode('discover_radar'), { mode: 'discover_radar', access: 'public' });
  for (const mode of ['parse_official_page', 'verify_genre', 'diagnose_tavily', 'diagnose_giometti_structure', 'diagnose_18tickets_live']) {
    assert.equal(classifyMode(mode).access, 'operator', mode);
  }
  for (const mode of ['DISCOVER_RADAR', 'diagnose_anything', '__proto__', 'constructor', ['discover_radar'], 42, {}]) {
    assert.equal(classifyMode(mode), null, String(mode));
  }
});

test('operator ids: only well-formed UUIDs are accepted', () => {
  const ids = parseOperatorIds(` ${OPERATOR.toUpperCase()}, not-a-uuid ,, *, 22222222-2222-4222-8222-222222222222 `);
  assert.deepEqual([...ids].sort(), [OPERATOR, '22222222-2222-4222-8222-222222222222']);
  assert.equal(parseOperatorIds(undefined).size, 0);
  assert.equal(parseOperatorIds('*').size, 0);
});

test('operator authorization fails closed', async () => {
  const operatorIds = parseOperatorIds(OPERATOR);
  const users = { 'a.op.sig': { id: OPERATOR }, 'a.member.sig': { id: '22222222-2222-4222-8222-222222222222' }, 'a.anon.sig': { id: OPERATOR, is_anonymous: true } };
  let calls = 0;
  const getUser = async token => { calls++; return fakeGetUser(users)(token); };

  assert.equal((await authorizeOperator({ authorization: 'Bearer a.op.sig', operatorIds: new Set(), getUser })).error, 'operator_access_not_configured');
  assert.equal((await authorizeOperator({ authorization: null, operatorIds, getUser })).status, 401);
  assert.equal((await authorizeOperator({ authorization: 'Basic a.op.sig', operatorIds, getUser })).status, 401);
  const before = calls;
  const publishable = await authorizeOperator({ authorization: 'Bearer sb_publishable_example', operatorIds, getUser });
  assert.deepEqual([publishable.status, publishable.error, calls], [401, 'operator_auth_invalid', before], 'API keys never reach Auth');
  assert.equal((await authorizeOperator({ authorization: 'Bearer x.forged.sig', operatorIds, getUser })).status, 401);
  assert.deepEqual(await authorizeOperator({ authorization: 'Bearer a.member.sig', operatorIds, getUser }), { ok: false, status: 403, error: 'operator_not_authorized' });
  assert.equal((await authorizeOperator({ authorization: 'Bearer a.anon.sig', operatorIds, getUser })).status, 403, 'anonymous sessions refused even if id is listed');
  assert.equal((await authorizeOperator({ authorization: 'Bearer a.op.sig', operatorIds, getUser: async () => { throw new Error('down'); } })).status, 503);
  assert.deepEqual(await authorizeOperator({ authorization: 'Bearer a.op.sig', operatorIds, getUser }), { ok: true, userId: OPERATOR });
});

test('dates: strict ISO calendar dates only', () => {
  for (const ok of ['2026-10-09', '2028-02-29']) assert.ok(isValidIsoDate(ok), ok);
  for (const bad of ['2026-02-30', '2026-13-01', '09/10/2026', '2026-10-09T00:00', '', null, 20261009]) assert.ok(!isValidIsoDate(bad), String(bad));
});

test('request body: size limit, JSON object only', async () => {
  const req = body => new Request('https://x.test', { method: 'POST', body });
  assert.deepEqual(await readJsonBody(req('{"mode":"status"}'), 100), { ok: true, value: { mode: 'status' } });
  assert.equal((await readJsonBody(req('x'.repeat(101)), 100)).status, 413);
  assert.equal((await readJsonBody(req('{bad'), 100)).error, 'invalid_json');
  assert.equal((await readJsonBody(req('[1]'), 100)).error, 'invalid_body');
  assert.equal((await readJsonBody(req('null'), 100)).error, 'invalid_body');
  assert.equal((await readJsonBody(new Request('https://x.test', { method: 'POST' }), 100)).error, 'invalid_json');
});

test('page reads are capped without buffering the whole body', async () => {
  let pulled = 0;
  const stream = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new TextEncoder().encode('a'.repeat(1000))); } });
  const text = await readTextCapped(new Response(stream), 1500);
  assert.equal(text.length, 1500);
  assert.ok(pulled <= 7, `stopped after ${pulled} chunks`);
  assert.equal(await readTextCapped(new Response('città – ok'), 100), 'città – ok');
});

test('addresses: loopback, private, link-local, metadata and special ranges are not public', () => {
  const blocked = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.10', '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1',
    'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '2001:db8::1', '2001::1', 'not-an-ip'];
  for (const a of blocked) assert.equal(isPublicAddress(a), false, a);
  for (const a of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2a00:1450:4002::200e', '::ffff:93.184.216.34']) assert.equal(isPublicAddress(a), true, a);
});

test('URLs: schemes, credentials, ports, local names and IP literals in any notation are refused', () => {
  const refused = {
    'file:///etc/passwd': 'protocol_not_allowed', 'ftp://example.com/': 'protocol_not_allowed', 'javascript:alert(1)': 'protocol_not_allowed',
    'data:text/html,x': 'protocol_not_allowed', 'https://user:pw@example.com/': 'credentials_not_allowed',
    'https://example.com:8443/': 'port_not_allowed', 'http://example.com:22/': 'port_not_allowed',
    'http://localhost/': 'host_not_allowed', 'http://LOCALHOST./': 'host_not_allowed', 'http://api.localhost/': 'host_not_allowed',
    'http://metadata.google.internal/': 'host_not_allowed', 'http://printer.local/': 'host_not_allowed', 'http://intranet/': 'host_not_allowed',
    'http://127.0.0.1/': 'private_address', 'http://2130706433/': 'private_address', 'http://0x7f.0.0.1/': 'private_address',
    'http://017700000001/': 'private_address', 'http://169.254.169.254/latest/meta-data/': 'private_address',
    'http://[::1]/': 'private_address', 'http://[::ffff:7f00:1]/': 'private_address', 'http://[fd00::1]/': 'private_address',
    'not a url': 'invalid_url',
  };
  for (const [url, reason] of Object.entries(refused)) assert.deepEqual(checkDestinationUrl(url), { ok: false, reason }, url);
  for (const url of ['https://www.giomettirealestatecinema.it/cinema/multiplex-ancona/programmazione', 'http://cinema.example.it/', 'https://ancona.movieland.18tickets.it:443/', 'http://93.184.216.34/']) {
    assert.equal(checkDestinationUrl(url).ok, true, url);
  }
});

function fakeNet(routes, dns) {
  const fetched = [];
  return {
    fetched,
    fetchImpl: async (href, init) => { fetched.push({ href, redirect: init.redirect }); if (!routes[href]) throw new Error('unexpected ' + href); return routes[href](); },
    resolveHost: async host => { if (!dns[host]) throw new Error('NXDOMAIN'); return dns[host]; },
  };
}
const page = (body = 'ok') => () => new Response(body, { status: 200 });
const moved = location => () => new Response(null, { status: 302, headers: { location } });

test('safeFetch: public destination is fetched with manual redirects', async () => {
  const net = fakeNet({ 'https://cinema.example.it/a': moved('/b'), 'https://cinema.example.it/b': page('final') }, { 'cinema.example.it': ['93.184.216.34'] });
  const { response, url } = await createSafeFetch(net)('https://cinema.example.it/a');
  assert.equal(url, 'https://cinema.example.it/b');
  assert.equal(await response.text(), 'final');
  assert.ok(net.fetched.every(f => f.redirect === 'manual'));
});

async function assertBlocked(promise, reason) {
  await assert.rejects(promise, e => e instanceof DestinationBlockedError && e.reason === reason);
}

test('safeFetch: hostnames resolving to private addresses are never contacted', async () => {
  const net = fakeNet({}, { 'rebind.example.com': ['93.184.216.34', '10.0.0.5'], 'internal.example.com': ['::1'] });
  await assertBlocked(createSafeFetch(net)('https://rebind.example.com/'), 'private_address');
  await assertBlocked(createSafeFetch(net)('https://internal.example.com/'), 'private_address');
  await assertBlocked(createSafeFetch(net)('https://unknown.example.com/'), 'dns_resolution_failed');
  assert.equal(net.fetched.length, 0);
});

test('safeFetch: redirects to metadata, localhost or other schemes are stopped before the second request', async () => {
  for (const [target, reason] of [['http://169.254.169.254/latest/meta-data/', 'private_address'], ['http://localhost:8080/', 'port_not_allowed'],
    ['http://localhost/', 'host_not_allowed'], ['file:///etc/passwd', 'protocol_not_allowed'], ['http://[::1]/', 'private_address']]) {
    const net = fakeNet({ 'https://cinema.example.it/': moved(target) }, { 'cinema.example.it': ['93.184.216.34'] });
    await assertBlocked(createSafeFetch(net)('https://cinema.example.it/'), reason);
    assert.deepEqual(net.fetched.map(f => f.href), ['https://cinema.example.it/'], target);
  }
});

test('safeFetch: redirect loops are bounded', async () => {
  const net = fakeNet({ 'https://cinema.example.it/loop': moved('/loop') }, { 'cinema.example.it': ['93.184.216.34'] });
  await assertBlocked(createSafeFetch({ ...net, maxRedirects: 5 })('https://cinema.example.it/loop'), 'too_many_redirects');
  assert.equal(net.fetched.length, 6);
});

test('service role client is limited to the radar tables', () => {
  const client = { from: table => ({ table }), rpc: () => 'rpc', auth: { admin: {} }, storage: {} };
  const scoped = restrictTables(client, ['radar_cinemas', 'radar_movie_classification']);
  assert.deepEqual(scoped.from('radar_cinemas'), { table: 'radar_cinemas' });
  assert.throws(() => scoped.from('user_feedback'), /service_table_not_allowed/);
  assert.throws(() => scoped.from('profiles'), /service_table_not_allowed/);
  assert.equal(scoped.rpc, undefined);
  assert.equal(scoped.auth, undefined);
  assert.equal(scoped.storage, undefined);
  assert.ok(Object.isFrozen(scoped));
});
