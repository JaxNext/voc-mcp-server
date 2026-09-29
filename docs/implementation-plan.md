# Voc MCP Server — Implementation Plan

> Companion to [tech-design.md](tech-design.md). Section references (§n) point there.
>
> **Status:** not started. Tick boxes as work completes.
>
> **Constraint:** no changes to the [`voc`](../../voc) repository (§12, §14 **R4**). Every task
> below is code or configuration in *this* repo, plus two manual client registrations in
> Supabase (Task 4 and Task 7).

**Legend:** `[ ]` not started · `[x]` done · each task ends with **Exit criteria** — the
observable result that proves the task is finished.

**Prerequisites** — complete before Task 1. A prerequisite counts as met only when its check
passes, not when it reads as plausible.

- [x] **pnpm** — `pnpm -v` → `12.5.1`
- [x] **Node 20+** — `node -v` → `v24.21.0` (nvm `default` alias set, so login *and*
      non-login shells resolve `node`/`npm`/`npx`)
- [x] **Cloudflare account, logged in** — `pnpm dlx wrangler whoami` →
      `qianjunyinggo@gmail.com`, account **Jax** (`478168264ac75d96c100098a581c6500`),
      credentials in `~/Library/Preferences/.wrangler/config/default.toml`
- [x] **Supabase project reachable** — ref is **`mqehfyrkgyzodlqwkozf`**
      (`https://mqehfyrkgyzodlqwkozf.supabase.co`); OIDC discovery returns `200`
- [x] **git identity set** — `qianjunyinggo@gmail.com` / `JaxNext`
- [ ] **Dashboard access to Supabase → Authentication → OAuth Apps** — the client list at
      `https://supabase.com/dashboard/project/mqehfyrkgyzodlqwkozf/auth/oauth` is where the
      existing test client `9b5a1ba3-…` lives and where Task 4 and Task 7 each register one
- [ ] **`workers.dev` subdomain known** — needed to write exact redirect URIs (§7.4). This is
      **not** the account id: it is the account-level subdomain in `<subdomain>.workers.dev`,
      shown in the dashboard under Workers & Pages and printed by the first `wrangler deploy`.
      Not needed until Task 7.

**Re-run these to confirm the toolchain at any time:**

```bash
node -v                                   # v24.21.0, after `nvm alias default 24`
pnpm -v                                   # 12.5.1
pnpm dlx wrangler whoami                  # account + email, or "not authenticated"
curl -sS -o /dev/null -w '%{http_code}\n' \
  "https://mqehfyrkgyzodlqwkozf.supabase.co/auth/v1/.well-known/openid-configuration"
# 200. If this resolves to a 198.18.x.x address instead, a local TUN proxy
# (Clash/Surge) is hijacking *.supabase.co — see the troubleshooting record in
# voc/docs/1.1-auth-and-shell.md, and fix the proxy before blaming the code.
```

---

## Task 1 — Scaffold the Worker

**Goal:** a Worker that boots and serves an empty MCP endpoint, with config, bindings and the
test harness in place (§8).

- [x] `pnpm init`; `tsconfig.json` with `strict: true`
- [x] Add runtime deps, exact-pinned: `agents@0.24.0`, `@modelcontextprotocol/server@2.0.0`,
      `@cloudflare/workers-oauth-provider@1.1.0`, `zod@4.6.5`
- [x] Add dev deps: `wrangler@4.124.0`, `typescript@7.0.2`, `@cloudflare/workers-types@5.20260928.1`,
      `vitest@4.1.11`, `@cloudflare/vitest-pool-workers@0.22.0`
- [x] `pnpm-workspace.yaml` — `allowBuilds` for `esbuild`, `core-js-pure`, `workerd`
      (pnpm 12 blocks postinstall scripts by default; moved out of the dead `pnpm` package.json field)
- [x] `wrangler.jsonc` — `name`, `main`, `compatibility_date: "2026-08-22"`,
      `compatibility_flags: ["nodejs_compat"]`, `observability.enabled`, `vars`
      *(the design's `2026-09-01` is above the newest date supported by pool-workers 0.22.0's
      pinned runtime — see [1.1-worker-scaffold.md](1.1-worker-scaffold.md); bump both together)*
- [x] Declare both KV bindings: `OAUTH_KV`, `VOC_SESSIONS` (placeholder ids; Task 7 fills real ones)
- [x] `src/types/env.ts` — typed `Env` for the bindings and vars
- [x] `src/mcp/server.ts` — `createServer()` returning an `McpServer` with no tools yet
- [x] `src/index.ts` — minimal `fetch` export (no OAuth wiring yet)
- [x] `wrangler.jsonc` has **no** Durable Object block and **no** service-role binding (§8)
- [x] `vitest.config.ts` using the Workers pool (v4 plugin shape: `cloudflareTest()` in `plugins`;
      the old `defineWorkersConfig` from `…/config` no longer exists in 0.22.0)
- [x] `.gitignore` for `.wrangler/`, `node_modules/`, `.dev.vars`

**Exit criteria:** `wrangler dev` starts and answers on `/mcp`; `tsc --noEmit` is clean. ✅
Both verified 2026-09-29: `tsc` clean; `test/smoke.spec.ts` green under the Workers pool;
`/mcp` → `501 {"error":"not_wired_yet"}`, `/` → `200`.

---

## Task 2 — Voc data layer (`src/voc/*`)

**Goal:** the write/read semantics of §5.3 as a tested module with no MCP coupling.

**PostgREST client**
- [x] `src/voc/postgrest.ts` — typed fetch wrapper: base URL from `VOC_SUPABASE_URL`,
      `apikey: <anon>` + `Authorization: Bearer <Voc JWT>` on every request
      *(anon key added to `Env` as `VOC_SUPABASE_ANON_KEY` — secret in `.dev.vars`, §8)*
- [x] Error mapping: surface PostgREST `status`, `message`, `details` — never a raw dump (§9)
- [x] Treat `200 + []` and `PGRST116` as *not found*, never as "user has no records" (§9)

**Records**
- [x] `createRecord` — 3-step composite: `records` → `record_tags` (only if tags) →
      `review_states` with **no fields** (DB defaults make it due immediately)
- [x] `createRecord` — rollback: any failure after step 1 deletes the record; the error says
      which step failed and that nothing was saved
- [x] `searchRecords` — `or=(content.ilike.…,meaning.ilike.…)` after stripping `,` `(` `)` from
      the term
- [x] `searchRecords` — tag filter as the **two-step union** (resolve ids from `record_tags`,
      then `id=in.(…)`), not an `!inner` join
- [x] `searchRecords` — stable tiebreak on `id`; return `{ records, total, hasMore, page }`
- [x] `getRecord` — record + tags + review state (`status`, `next_review_at`)
- [x] `updateRecord` — read-modify-write with the **full** `{type, content, meaning, source,
      notes}` set, then a tag **diff** (remove only deselected, add only new)
- [x] `deleteRecord` — relies on `on delete cascade`; returns the deleted content for the
      confirmation message

**Tags**
- [x] `listTags` — predefined + custom, as `{ name, is_predefined }`
- [x] `resolveTagNames` — case-insensitive match against the visible set; unknown → error
      listing close matches and pointing at `list_tags` (§14 **R2**); no silent creation

**Schemas**
- [x] `src/mcp/shared/schemas.ts` — Zod schemas at Voc's exact limits (content ≤ 500,
      meaning ≤ 2000, source ≤ 500, notes ≤ 4000)

**Tests**
- [x] `test/records.spec.ts` against a stubbed PostgREST: create happy path, rollback on
      step-2 and step-3 failure, update tag diff, cascade-delete call shape
- [x] `test/search.spec.ts`: `,()` are stripped; tag filtering issues the union, not `!inner`
- [x] `test/tags.spec.ts`: case-insensitivity, predefined ∪ custom, unknown-name error
- [x] Zod boundary tests: content 501 and meaning 2001 are rejected

**Exit criteria:** all unit tests green with no network access. ✅ Verified 2026-09-29:
34 tests green (records 15, search 10, tags 8, smoke 1) under the Workers pool with an
injected stub fetch; `tsc --noEmit` clean. See [1.2-data-layer.md](1.2-data-layer.md).

---

## Task 3 — The six MCP tools

**Goal:** the §6 tool surface wired to Task 2, runnable before OAuth exists so iteration is fast.

**Shared helpers**
- [x] `src/mcp/shared/result.ts` — `content[]` formatting helpers (plus
      `src/mcp/shared/session.ts` — `VocSession`/`VocSessionFactory` injection point for Task 5)
- [x] `src/mcp/shared/errors.ts` — `isError: true` tool-result helpers; every message names a
      next step (§9); one `toErrorResult` dispatcher maps `UnknownTagError`/`PostgrestError`/unknown

**Tools** (one file each, §4)
- [x] `create-record.ts` — returns the created record **with its id**
- [x] `search-records.ts` — mirrors `RecordListFilters`; says so explicitly when `total`
      exceeds what was returned ("Showing 20 of 57. Narrow the filters, raise the page, or
      increase pageSize to see the rest.")
- [x] `get-record.ts` — structured not-found error pointing at `search_records`
- [x] `update-record.ts` — omitted field = unchanged; `null` clears `source`/`notes`;
      `tags: []` removes all, `tags` omitted leaves associations alone (read-modify-write
      over `getRecord` + tag diff)
- [x] `delete-record.ts` — description warns review history is destroyed and unrecoverable;
      confirmation repeats the warning
- [x] `list-tags.ts` — no inputs (`inputSchema` omitted); exists so the assistant can
      discover valid tag names

**Annotations** (every tool)
- [x] `title` on all six
- [x] `readOnlyHint` true on `search_records`, `get_record`, `list_tags`
- [x] `destructiveHint: true` on `delete_record` only
- [x] Descriptions state what the tool does, what it returns, and what it does **not** do
- [x] No tool accepts a `user_id` — identity comes from `authInfo` (Task 5); until then the
      `/mcp` bearer token **is** the Voc JWT and `userId` is its `sub` claim (dev-only
      scaffolding in `src/index.ts`, replaced in Task 5)
- [x] Register all six in `src/mcp/server.ts`

**Tests**
- [x] `test/tools.spec.ts` — happy path per tool, plus not-found and unknown-tag error shapes
      (13 tests over `InMemoryTransport` + MCP `Client`, the same path Inspector takes)

**Exit criteria:** MCP Inspector lists exactly six tools with the annotations above; each is
callable with a hand-pasted Voc JWT. ✅ Verified 2026-09-29: 47 tests green (tools 13, records
15, search 10, tags 8, smoke 1); `tsc --noEmit` clean; against `wrangler dev` on :8787,
`initialize` + `tools/list` over streamable HTTP returned exactly the six tools with the §6
annotations, and a missing bearer token got 401. A real Voc JWT end-to-end call needs the real
anon key + a live Supabase — that final smoke is a user step (Voc keeps no local `.env`).
See [1.3-mcp-tools.md](1.3-mcp-tools.md).

---

## Task 4 — Worker as an OAuth client of Voc

**Goal:** the browser flow of §3 ends with a Voc token in KV (§7.3).

- [ ] `src/auth/token-store.ts` — KV get/put/delete of
      `{ refresh_token, access_token, expires_at, scope }` keyed by `voc_user_id`
- [ ] `src/auth/handler.ts` — `defaultHandler` starts the authorization-code + PKCE flow
      against Supabase with the `VOC_CLIENT_ID`
- [ ] `src/auth/handler.ts` — `/callback` exchanges the code at
      `POST /auth/v1/oauth/token` (`auth method: none`), stores the session, returns grant
      props
- [ ] Grant props carry **only** `{ voc_user_id, voc_email }` — no refresh token, because
      props are write-once and cannot rotate (§7.3)
- [ ] Request `offline_access` at authorize time (§7.5)
- [ ] `src/auth/consent.ts` — Worker-side consent screen with CSRF via `__Host-CSRF_TOKEN`
      and escaped `client_name` / `logo_uri`
- [ ] Pin `wrangler dev` to port **8787** so the registered redirect URI stays valid
- [ ] **Manual:** register `Voc MCP Server (dev)`, type `public`, redirect
      `http://localhost:8787/callback` in Supabase → Authentication → OAuth Apps (§7.4)
- [ ] Do **not** reuse the existing test client `9b5a1ba3-…` — its redirect URI is
      `http://localhost:3000/callback` (§7.4)

**Tests**
- [ ] `test/auth.spec.ts` — a full PKCE exchange against a mocked Supabase lands the session in
      `VOC_SESSIONS` and yields props with `voc_user_id` but **no** refresh token

**Exit criteria:** a browser walk-through completes both consents and leaves a Voc token in
`VOC_SESSIONS`.

---

## Task 5 — `OAuthProvider` around `/mcp`

**Goal:** MCP clients can discover, register and call the server (§7.1, §7.2).

- [ ] Wire `OAuthProvider` in `src/index.ts` per the §8 shape: `apiRoute: '/mcp'`,
      `defaultHandler`, `authorizeEndpoint: '/authorize'`, `tokenEndpoint: '/token'`,
      `clientRegistrationEndpoint: '/register'`
- [ ] `apiHandler: createMcpHandler(createServer)`; confirm the SDK is on the **v2** stateless
      path (no `initialize`, no `Mcp-Session-Id`) — §3.1
- [ ] `accessTokenTTL` set long (the client token gates nothing but this Worker) — §7.3
- [ ] Set `allowedHostnames` to the deployment hostname (DNS-rebinding hardening) — §10
- [ ] RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource`
- [ ] Tools read `voc_user_id` from `authInfo.props` and load the credential from
      `VOC_SESSIONS` — never from a tool argument (§8)
- [ ] DCR-only: do not attempt CIMD (§14 **R1**)

**Tests**
- [ ] Integration: AS + protected-resource metadata are well-formed
- [ ] Integration: `/register` returns a usable client
- [ ] Integration: `/mcp` rejects a missing or foreign bearer token

**Exit criteria:** MCP Inspector completes discovery → DCR → authorize → token → a real tool
call, end to end.

---

## Task 6 — Token refresh and 401 recovery

**Goal:** the long-lived behaviour of §7.3.

- [ ] Read the Voc access token per request; refresh when it expires within 60s
- [ ] Refresh via `POST /auth/v1/oauth/token` with `grant_type=refresh_token`; write the new
      pair back to `VOC_SESSIONS`
- [ ] On refresh failure (revoked / expired / signed out of Voc): delete the KV entry and
      return `401` with a `WWW-Authenticate` challenge so the client re-runs the full flow
- [ ] Never degrade a 401 into empty results — an assistant must not conclude "no records" (§7.3)
- [ ] Confirm refresh-token rotation is acceptable for a single-user deployment; note the
      Durable Object escape hatch if concurrent refreshes ever collide (§7.3)

**Tests**
- [ ] Refresh-on-expiry path succeeds and persists the new token pair
- [ ] Refresh-failure path returns 401 + `WWW-Authenticate`
- [ ] Revocation is surfaced as re-authentication, **not** as `[]` or zeroed output

**Exit criteria:** TTL expiry and session revocation both resolve by re-authentication.

---

## Task 7 — Deploy

**Goal:** a live server a real MCP host can use.

- [ ] Create the two KV namespaces; put the real ids into `wrangler.jsonc`
- [ ] Set production `VOC_REDIRECT_URI` and `VOC_OAUTH_CLIENT_ID`
- [ ] `wrangler deploy`
- [ ] **Manual:** register `Voc MCP Server` (production) with
      `https://voc-mcp.<account>.workers.dev/callback` in Supabase → OAuth Apps (§7.4)
- [ ] Redirect URIs match **exactly** — no wildcards (§7.4)
- [ ] Run the §11 end-to-end checklist against the deployed URL
- [ ] Confirm `wrangler tail` shows no token material in logs (§10)

**Exit criteria:** the live URL works as a Claude custom connector, and the §11 manual E2E
checks pass.

---

## Definition of done

- [ ] Six tools, exactly as specified in §6, with correct annotations
- [ ] Zero commits in the `voc` repository
- [ ] No service-role key anywhere in this project (§10)
- [ ] Unit, integration and manual E2E checks in §11 all pass
- [ ] The three review tools are **not** implemented — deferred in §14 **O5**
- [ ] Tag creation is **not** implemented — §14 **R2**
