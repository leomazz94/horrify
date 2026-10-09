// Source-level guarantees that runtime tests cannot cover exhaustively.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_MODES, OPERATOR_MODES } from '../../horror-radar-test/security.mjs';
import { INDEX_PATH, FUNCTION_DIR } from './harness.mjs';

const source = await readFile(INDEX_PATH, 'utf8');
const ARCHIVE_DIR = path.resolve(FUNCTION_DIR, '../../archive/horror-radar-test-v43');

test('every mode handled in index.ts is registered, and every registered mode is handled', () => {
  const handled = new Set([...source.matchAll(/mode\s*[!=]==\s*"([a-z0-9_]+)"/g)].map(m => m[1]));
  const registered = new Set([...PUBLIC_MODES, ...OPERATOR_MODES]);
  for (const mode of handled) assert.ok(registered.has(mode), 'unregistered mode: ' + mode);
  for (const mode of registered) if (mode !== 'status') assert.ok(handled.has(mode), 'registered but not handled: ' + mode);
});

test('the authorization gate runs before the first mode branch', () => {
  const gate = source.indexOf('authorizeOperator('), firstMode = source.search(/b\?\.mode===/);
  assert.ok(gate > 0 && firstMode > gate);
  assert.ok(source.indexOf('classifyMode(') < gate);
  assert.ok(!source.includes('req.json()'), 'body must go through readJsonBody');
});

test('raw fetch is used only for fixed endpoints; pages go through safeFetch', () => {
  const sites = [...source.matchAll(/[^\w.]fetch\(([^,)]*)/g)].map(m => m[1].trim());
  assert.deepEqual(sites.sort(), ['"https://api.tavily.com/search"', 'endpoint']);
  assert.match(source, /const endpoints=\["https:\/\/overpass\.kumi\.systems\/api\/interpreter","https:\/\/overpass\.nchc\.org\.tw\/api\/interpreter","https:\/\/overpass-api\.de\/api\/interpreter"\]/);
  assert.match(source, /async function inspectOfficialPage\(url:string\)\{let page;try\{page=await safeFetch\(/);
  assert.ok(!/redirect:\s*"follow"/.test(source));
});

test('service role key is read once and only wrapped by restrictTables', () => {
  assert.equal(source.match(/SUPABASE_SERVICE_ROLE_KEY/g).length, 1);
  assert.match(source, /serviceDb=restrictTables\(createClient\(url,key,/);
  assert.equal(source.match(/createClient\(/g).length, 2, 'service (scoped) + anon auth client');
  assert.match(source, /authClient\?\?=createClient\(url,anon,/);
});

test('v43 archive is byte-identical to the recorded checksums', async () => {
  const sums = (await readFile(path.join(ARCHIVE_DIR, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  assert.equal(sums.length, 2);
  for (const line of sums) {
    const [, hash, name] = /^([0-9a-f]{64}) \*?(.+)$/.exec(line.trim());
    const actual = createHash('sha256').update(await readFile(path.join(ARCHIVE_DIR, name))).digest('hex');
    assert.equal(actual, hash, name);
  }
  assert.equal(sums.find(l => l.endsWith('index.ts')).slice(0, 64), 'efe7a26ea3ca9f0faa422718f7442b96f0233fe5ea95d216bb8960eb44958ddc');
});

test('no credentials in the function or its tests', async () => {
  const dirs = [FUNCTION_DIR, path.dirname(fileURLToPath(import.meta.url))];
  for (const dir of dirs) {
    for (const name of await readdir(dir)) {
      const text = await readFile(path.join(dir, name), 'utf8');
      assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(text), name + ': JWT-like string');
      assert.ok(!/sb_secret_[A-Za-z0-9]{8,}/.test(text), name + ': Supabase secret key');
      assert.ok(!/tvly-[A-Za-z0-9]{8,}/.test(text), name + ': Tavily key');
    }
  }
});
