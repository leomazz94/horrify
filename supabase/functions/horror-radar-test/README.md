# Horror Radar test function — security hardening of v43

Source of the Supabase Edge Function `horror-radar-test`, based on v43 (archived unchanged in `supabase/archive/horror-radar-test-v43/`, checksums in `SHA256SUMS`). Parsers, cinema search, fallback and genre logic are unchanged; only access control, outbound requests and service-role use were hardened. Not deployed.

## Access

| Mode | Access |
|---|---|
| `status` (no mode), `discover_radar` | Public, as in v43 |
| `parse_official_page`, `verify_genre`, `diagnose_*` | Operators only |
| anything else | `400 unknown_mode` |

Operators are the Supabase Auth user ids listed in the secret `RADAR_OPERATOR_USER_IDS` (comma separated). The caller must send a user session (`Authorization: Bearer <access_token>`), validated server-side with `auth.getUser` using the anon key. API keys, anonymous sessions and unlisted users are refused. If the secret is missing or empty, nobody is an operator (`403 operator_access_not_configured`).

Every new mode must be added to `PUBLIC_MODES` or `OPERATOR_MODES` in `security.mjs`; the static test fails otherwise.

## Outbound requests

Cinema pages (from `radar_cinemas.website`, from links found on those pages, or from operator input) are fetched only through `safeFetch`:

- `http`/`https` only, ports 80/443, no credentials in the URL;
- no `localhost`, single-label, `.local`, `.internal`, `.lan`, `.home.arpa`, `.intranet`, `.corp` hosts;
- IP literals and every DNS answer (A and AAAA) must be public: loopback, private, link-local/metadata, CGNAT, multicast, documentation, IPv4-mapped/NAT64/6to4 forms of those are refused;
- redirects are followed manually (max 5) and each hop is re-validated;
- bodies are read up to 1.5M characters without buffering the rest.

If the runtime cannot resolve DNS (`Deno.resolveDns`), pages are not fetched (`official_page_blocked_dns_resolution_failed`). Blocks are logged as `radar_destination_blocked` with host and reason.

Raw `fetch` remains only for fixed endpoints: Tavily and the (unused) Overpass list.

### Known limits (SSRF protection is partial)

- **DNS rebinding is not prevented.** The address check uses `Deno.resolveDns`, then `fetch` resolves the name again. A domain with a very short TTL can answer with a public address to the check and a private one to the fetch. Deno's `fetch` cannot be pinned to a pre-validated IP, so closing this needs an egress proxy that resolves and filters in one step, or a reviewed allowlist of domains.
- **The two lookups may use different resolvers.** `Deno.resolveDns` and `fetch` do not necessarily share the same resolver configuration (for example, local hosts entries), so they may see different answers.
- **`Deno.resolveDns` on the hosted Edge Runtime is unverified.** The edge-runtime source exposes it to user workers, but it has not been tested on the deployed platform. If it is missing, every page fetch is blocked and `discover_radar` falls back to Tavily.
- Untrusted page content still reaches callers indirectly: extracted candidates in `discover_radar` and HTML samples in operator diagnostics.

## Service role

The service-role client is created lazily and wrapped by `restrictTables`: only `radar_cinemas` and `radar_movie_classification` are reachable, with no `rpc`, `auth` or `storage`. Public callers can still cause cache writes through `discover_radar` (titles found on cinema pages), as in v43; arbitrary titles can be written only by operators through `verify_genre`.

## Secrets

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (provided by Supabase), `TAVILY_API_KEY`, `RADAR_OPERATOR_USER_IDS` (new). None belong in this repository.

## Offline tests

Node 22.6+ (type stripping and `node:test`); no packages, no network:

```sh
node --test supabase/functions/tests/horror-radar-test/*.test.mjs
```

The harness loads the real `index.ts` with fake Deno, Supabase and network, and fails on any unexpected outbound request.

## Before deploying

1. `deno check supabase/functions/horror-radar-test/index.ts` (type check with the real imports).
2. Set `RADAR_OPERATOR_USER_IDS` to the operator ids, then deploy to a staging project or a differently named function first.
3. Check in staging:
   - no session → `diagnose_tavily` returns 401; a regular account → 403; an operator → 200;
   - `parse_official_page` with `http://169.254.169.254/` → 502 `official_page_blocked_private_address`;
   - `diagnose_18tickets_live` as operator → `fetched: true` (proves `Deno.resolveDns` and manual redirects work on the Edge Runtime);
   - `discover_radar` from the test page → same response shape as v43; logs contain no `dns_unavailable`.
4. Only then deploy over `horror-radar-test`.
