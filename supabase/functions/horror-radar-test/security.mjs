// Security policy for horror-radar-test. Plain ESM with no dependencies: it runs on the
// Supabase Edge Runtime (Deno) and on Node for offline tests.

// Every mode the handler serves must be listed here; anything else is rejected before dispatch.
export const PUBLIC_MODES = new Set(['status', 'discover_radar']);
export const OPERATOR_MODES = new Set([
  'parse_official_page', 'verify_genre', 'diagnose_tavily', 'diagnose_giometti_structure',
  'diagnose_18tickets_stage', 'diagnose_18tickets_pipeline', 'diagnose_18tickets_context',
  'diagnose_18tickets_structure', 'diagnose_18tickets_live', 'diagnose_18tickets_parser',
]);

export function classifyMode(mode) {
  if (mode === undefined || mode === null || mode === '') return { mode: 'status', access: 'public' };
  if (typeof mode !== 'string') return null;
  if (PUBLIC_MODES.has(mode)) return { mode, access: 'public' };
  if (OPERATOR_MODES.has(mode)) return { mode, access: 'operator' };
  return null;
}

// ---------------------------------------------------------------- operator authorization

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// RADAR_OPERATOR_USER_IDS: comma/space separated Supabase Auth user ids. Empty means nobody.
export function parseOperatorIds(raw) {
  return new Set(String(raw || '').split(/[\s,]+/).filter(id => UUID.test(id)).map(id => id.toLowerCase()));
}

// Fails closed: no configured operators, missing/invalid session, anonymous or unlisted users are refused.
// getUser(token) must validate the token server-side (Supabase Auth), returning { data: { user }, error }.
export async function authorizeOperator({ authorization, operatorIds, getUser }) {
  if (!operatorIds || operatorIds.size === 0) return { ok: false, status: 403, error: 'operator_access_not_configured' };
  const match = /^Bearer\s+(\S+)$/i.exec(authorization || '');
  if (!match) return { ok: false, status: 401, error: 'operator_auth_required' };
  const token = match[1];
  // Publishable/anon API keys are not user sessions and never reach Auth.
  if (!JWT.test(token)) return { ok: false, status: 401, error: 'operator_auth_invalid' };
  let result;
  try { result = await getUser(token); } catch { return { ok: false, status: 503, error: 'operator_auth_unavailable' }; }
  const user = result?.data?.user;
  if (result?.error || !user?.id) return { ok: false, status: 401, error: 'operator_auth_invalid' };
  if (user.is_anonymous) return { ok: false, status: 403, error: 'operator_not_authorized' };
  if (!operatorIds.has(String(user.id).toLowerCase())) return { ok: false, status: 403, error: 'operator_not_authorized' };
  return { ok: true, userId: user.id };
}

// ---------------------------------------------------------------- request input

export function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export async function readJsonBody(req, maxChars) {
  const text = await readTextCapped(req, maxChars + 1);
  if (text.length > maxChars) return { ok: false, status: 413, error: 'payload_too_large' };
  let value;
  try { value = JSON.parse(text); } catch { return { ok: false, status: 400, error: 'invalid_json' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, status: 400, error: 'invalid_body' };
  return { ok: true, value };
}

// Reads at most maxChars characters of a Request/Response body without buffering the rest.
// Decodes as UTF-8 like Response.text(); 4 bytes per character is the UTF-8 upper bound.
export async function readTextCapped(source, maxChars) {
  const body = source?.body;
  if (!body) return '';
  const maxBytes = maxChars * 4, reader = body.getReader(), chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (total >= maxBytes) await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.length;
    if (offset >= bytes.length) break;
  }
  return new TextDecoder('utf-8').decode(bytes).slice(0, maxChars);
}

// ---------------------------------------------------------------- outbound network policy

export function parseIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every(n => n <= 255) ? octets : null;
}

export function isPublicIPv4([a, b, c]) {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-network, private, loopback, multicast/reserved
  if (a === 100 && b >= 64 && b <= 127) return false;             // carrier-grade NAT
  if (a === 169 && b === 254) return false;                       // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;              // private
  if (a === 192 && b === 168) return false;                       // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false;            // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return false;          // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;           // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false;            // TEST-NET-3
  return true;
}

export function parseIPv6(input) {
  let s = String(input);
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s.includes(':') || s.includes('%')) return null;
  const lastColon = s.lastIndexOf(':'), last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    s = s.slice(0, lastColon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 1) groups = head;
  else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8 || !groups.every(g => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map(g => parseInt(g, 16));
}

const embeddedV4 = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

export function isPublicIPv6(w) {
  if (w.slice(0, 6).every(x => x === 0)) return false;                                        // ::, ::1, IPv4-compatible
  if (w.slice(0, 5).every(x => x === 0) && w[5] === 0xffff) return isPublicIPv4(embeddedV4(w[6], w[7])); // IPv4-mapped
  if (w[0] === 0x64 && w[1] === 0xff9b) {                                                       // NAT64
    return w.slice(2, 6).every(x => x === 0) && isPublicIPv4(embeddedV4(w[6], w[7]));
  }
  if (w[0] === 0x2002) return isPublicIPv4(embeddedV4(w[1], w[2]));                             // 6to4
  if (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0xdb8)) return false;                          // Teredo, documentation
  return (w[0] & 0xe000) === 0x2000;                                                            // global unicast only
}

export function isPublicAddress(address) {
  const v4 = parseIPv4(address);
  if (v4) return isPublicIPv4(v4);
  const v6 = parseIPv6(address);
  return v6 ? isPublicIPv6(v6) : false;
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa', '.corp'];

export class DestinationBlockedError extends Error {
  constructor(reason) { super('destination_blocked:' + reason); this.name = 'DestinationBlockedError'; this.reason = reason; }
}

// Static checks on a URL (no DNS). Returns { ok, url, literalIp } or { ok:false, reason }.
export function checkDestinationUrl(raw, base) {
  let url;
  try { url = base === undefined ? new URL(String(raw)) : new URL(String(raw), base); } catch { return { ok: false, reason: 'invalid_url' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'protocol_not_allowed' };
  if (url.username || url.password) return { ok: false, reason: 'credentials_not_allowed' };
  if (url.port && url.port !== '80' && url.port !== '443') return { ok: false, reason: 'port_not_allowed' };
  url.hash = '';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    const words = parseIPv6(host);
    return words && isPublicIPv6(words) ? { ok: true, url, literalIp: true } : { ok: false, reason: 'private_address' };
  }
  const v4 = parseIPv4(host);
  if (v4) return isPublicIPv4(v4) ? { ok: true, url, literalIp: true } : { ok: false, reason: 'private_address' };
  if (!/^[a-z0-9_.-]+$/.test(host) || !host.includes('.') || host === 'localhost'
    || BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) return { ok: false, reason: 'host_not_allowed' };
  return { ok: true, url, literalIp: false };
}

// Static checks plus DNS: every resolved address must be public. Throws DestinationBlockedError.
export async function assertPublicDestination(raw, base, resolveHost) {
  const checked = checkDestinationUrl(raw, base);
  if (!checked.ok) throw new DestinationBlockedError(checked.reason);
  if (checked.literalIp) return checked.url;
  let addresses;
  try { addresses = await resolveHost(checked.url.hostname.replace(/\.$/, '')); } catch { throw new DestinationBlockedError('dns_resolution_failed'); }
  if (!Array.isArray(addresses) || addresses.length === 0) throw new DestinationBlockedError('dns_resolution_failed');
  if (!addresses.every(a => isPublicAddress(String(a)))) throw new DestinationBlockedError('private_address');
  return checked.url;
}

// fetch() replacement for third-party pages: validates the destination, follows redirects manually
// and re-validates every hop. One deadline covers the whole chain, like the original fetch timeout.
export function createSafeFetch({ fetchImpl, resolveHost, maxRedirects = 5, log = () => {} }) {
  return async function safeFetch(rawUrl, { headers = {}, timeoutMs = 6500 } = {}) {
    const signal = AbortSignal.timeout(timeoutMs);
    let current = String(rawUrl), base;
    for (let hop = 0; ; hop++) {
      let url;
      try { url = await assertPublicDestination(current, base, resolveHost); } catch (e) {
        let host = null;
        try { host = new URL(current, base).hostname; } catch { /* unparsable */ }
        log('radar_destination_blocked', { host, reason: e.reason || 'unknown', hop });
        throw e;
      }
      const response = await fetchImpl(url.href, { headers, redirect: 'manual', signal });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (!location) return { response, url: url.href };
      await response.body?.cancel().catch(() => {});
      if (hop >= maxRedirects) {
        log('radar_destination_blocked', { host: url.hostname, reason: 'too_many_redirects', hop });
        throw new DestinationBlockedError('too_many_redirects');
      }
      current = location;
      base = url.href;
    }
  };
}

// ---------------------------------------------------------------- service-role scoping

// Wraps the service-role client so only the listed tables are reachable (no auth admin, rpc or storage).
export function restrictTables(client, tables) {
  const allowed = new Set(tables);
  return Object.freeze({
    from(table) {
      if (!allowed.has(table)) throw new Error('service_table_not_allowed');
      return client.from(table);
    },
  });
}
