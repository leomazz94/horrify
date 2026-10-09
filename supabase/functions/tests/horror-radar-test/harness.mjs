// Loads the real horror-radar-test index.ts in Node with fake Deno, Supabase and network.
// Nothing leaves the process: any fetch to an unregistered URL fails the call and is recorded.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FUNCTION_DIR = path.resolve(here, '../../horror-radar-test');
export const INDEX_PATH = path.join(FUNCTION_DIR, 'index.ts');
export const SECURITY_URL = pathToFileURL(path.join(FUNCTION_DIR, 'security.mjs')).href;

// Test-only placeholder values, not real credentials.
export const TEST_ENV = Object.freeze({
  SUPABASE_URL: 'https://project.supabase.test',
  SUPABASE_ANON_KEY: 'anon-key-placeholder',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-placeholder',
  TAVILY_API_KEY: 'tavily-key-placeholder',
});
export const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';
export const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
export const OPERATOR_TOKEN = 'header.operator.signature';
export const MEMBER_TOKEN = 'header.member.signature';
export const ANON_USER_TOKEN = 'header.anonymous.signature';
export const USERS = {
  [OPERATOR_TOKEN]: { id: OPERATOR_ID, is_anonymous: false },
  [MEMBER_TOKEN]: { id: MEMBER_ID, is_anonymous: false },
  [ANON_USER_TOKEN]: { id: '33333333-3333-4333-8333-333333333333', is_anonymous: true },
};

let tmpDir = null, loadCount = 0;
export async function cleanup() { if (tmpDir) await rm(tmpDir, { recursive: true, force: true }); tmpDir = null; }

function replaceOnce(source, search, replacement) {
  if (!source.includes(search)) throw new Error('harness out of date, missing: ' + search);
  return source.replace(search, replacement);
}

// options.env: environment; options.dns: { host: [addresses] }; options.routes: { href: (init) => Response };
// options.tables: { table: rows } returned by selects; options.noDns: simulate a runtime without Deno.resolveDns.
// options.indexPath: load another version (e.g. the v43 archive) for before/after comparisons.
export async function loadHandler({ env = {}, dns = {}, routes = {}, tables = {}, noDns = false, indexPath = INDEX_PATH } = {}) {
  const state = { handler: null, fetches: [], blockedFetches: [], clients: [], tableCalls: [], writes: [], getUserCalls: [], logs: [] };
  const fakeFetch = async (input, init = {}) => {
    const href = typeof input === 'string' ? input : input.url;
    state.fetches.push({ href, redirect: init.redirect ?? 'follow' });
    const route = routes[href];
    if (!route) { state.blockedFetches.push(href); throw new Error('unexpected network call: ' + href); }
    return route(init);
  };
  const builder = (table, key) => {
    const ops = [];
    const proxy = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') {
          const single = ops.some(([op]) => op === 'maybeSingle' || op === 'single');
          const result = { data: single ? null : (tables[table] || []), error: null };
          return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
        }
        return (...args) => {
          ops.push([prop, args]);
          if (['insert', 'upsert', 'update', 'delete'].includes(prop)) state.writes.push({ table, op: prop, key });
          return proxy;
        };
      },
    });
    return proxy;
  };
  const createClient = (url, key) => {
    state.clients.push({ url, key });
    return {
      from(table) { state.tableCalls.push({ table, key }); return builder(table, key); },
      rpc() { throw new Error('rpc must not be reachable'); },
      auth: {
        async getUser(token) {
          state.getUserCalls.push({ key, token });
          const user = USERS[token];
          return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'invalid_jwt' } };
        },
      },
    };
  };
  const resolveDns = async (host, type) => {
    const found = (dns[host] || []).filter(a => (type === 'AAAA') === a.includes(':'));
    if (!found.length) throw new Error('NoData');
    return found;
  };
  const Deno = {
    env: { get: name => ({ ...TEST_ENV, ...env })[name] },
    serve: handler => { state.handler = handler; },
    ...(noDns ? {} : { resolveDns }),
  };
  const id = 'load' + (++loadCount);
  globalThis.__radarHarness ??= {};
  globalThis.__radarHarness[id] = { fetch: fakeFetch, Deno, createClient, console: { error: (...args) => state.logs.push(args), log: () => {} } };

  let source = stripTypeScriptTypes(await readFile(indexPath, 'utf8'));
  source = replaceOnce(source, 'import "jsr:@supabase/functions-js/edge-runtime.d.ts";', '');
  source = replaceOnce(source, 'import { createClient } from "npm:@supabase/supabase-js@2";', '');
  if (indexPath === INDEX_PATH) source = replaceOnce(source, 'from "./security.mjs"', `from ${JSON.stringify(SECURITY_URL)}`);
  const prelude = `const { fetch, Deno, createClient, console } = globalThis.__radarHarness[${JSON.stringify(id)}];\n`;
  tmpDir ??= await mkdtemp(path.join(os.tmpdir(), 'horror-radar-test-'));
  const file = path.join(tmpDir, id + '.mjs');
  await writeFile(file, prelude + source);
  await import(pathToFileURL(file).href);
  if (typeof state.handler !== 'function') throw new Error('Deno.serve was not called');
  return state;
}

export async function call(state, body, { token, method = 'POST', rawBody } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const req = new Request('https://project.supabase.test/functions/v1/horror-radar-test', {
    method, headers, body: method === 'POST' || method === 'PUT' ? (rawBody ?? JSON.stringify(body)) : undefined,
  });
  const res = await state.handler(req);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}

export const html = (body, status = 200, headers = {}) => () => new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
export const redirect = (location, status = 302) => () => new Response(null, { status, headers: { location } });
export const json = value => () => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
