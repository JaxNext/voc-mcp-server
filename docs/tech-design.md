# Voc MCP Server — Technical Design

> **Status:** Draft for review · **Repo:** `voc-mcp-server` · **Upstream:** [`voc`](../../voc) (`https://voc-9d5.pages.dev`)
>
> Wraps the Voc vocabulary app as a remote MCP server so an AI assistant can capture and
> curate vocabulary through tool calls.

---

## 1. Purpose & Scope

Give an AI assistant (Claude, and any other MCP host) a small set of MCP tools that read and
write the vocabulary records in the user's Voc account — "record this word for me", "find
every record tagged *travel* containing *commute*", "update the meaning of the last one I
saved".

In scope:

- **Remote, streamable-HTTP MCP server** running on Cloudflare Workers at
  `https://voc-mcp.<account>.workers.dev/mcp`.
- **Six tools** covering record capture, read, search, edit and delete, plus tag listing.
- **"Sign in with Voc"** — the user authenticates against their existing Voc/Supabase account.
  No separate credentials, no service account.
- **Zero changes to the Voc codebase.** The Worker reads and writes Voc's existing PostgREST
  surface with the user's own OAuth JWT, so RLS applies unchanged (§5.1). Voc is not deployed
  as part of this build.

Out of scope (explicitly):

- **Review / SRS / stats tools.** `GET /api/review/session`, `POST /api/review/grade` and
  `GET /api/stats` authenticate exclusively through the cookie session
  ([supabase.ts](../../voc/server/utils/supabase.ts)) and reject bearer tokens, so an external
  caller cannot reach them while Voc stays untouched (§5.2). Reimplementing the SRS math in the
  Worker is not an acceptable substitute — it would put a second scheduler on the same
  `review_states` rows. Deferred, not rejected: see §14 **O5**.
- **Tag creation** (`create_tag`) — excluded per decision; `list_tags` is read-only. See
  §14 **R2**.
- **Multi-user productisation.** This is a personal server; the design is single-tenant in
  spirit but does not break with multiple users.

---

## 2. Locked Decisions

| # | Decision | Value |
|---|---|---|
| 1 | Deployment model | Remote streamable-HTTP MCP server on Cloudflare Workers |
| 2 | Host | `workers.dev` subdomain |
| 3 | MCP framework | `createMcpHandler()` from `agents/mcp/server` + MCP SDK v2 (`@modelcontextprotocol/server`) |
| 4 | MCP tool pattern | One tool per action, 6 tools total |
| 5 | Auth to MCP clients | OAuth 2.1 — **DCR only** (CIMD is not supported by the Cloudflare provider library; see §14 **R1**) |
| 6 | Auth to Voc | Sign in with Voc — Supabase OAuth 2.1 + PKCE (public client) |
| 7 | Voc codebase changes | **None.** The Worker uses Voc's existing PostgREST surface with the user's own OAuth JWT (§5.1) |

---

## 3. Architecture

Two OAuth relationships run through one Worker. This is the part of the design that is easy
to get wrong, so it is worth stating plainly:

```
        ┌─────────────────┐                     ┌──────────────────────────┐
        │   MCP client    │                     │  Worker: voc-mcp-server  │
        │ (Claude, etc.)  │                     │                          │
        └────────┬────────┘                     │  ┌────────────────────┐  │
                 │                              │  │  OAuthProvider     │  │
   1. discovery  │  GET /.well-known/...        │  │  (AS to clients)   │  │
                 ├─────────────────────────────►│  │  /authorize        │  │
                 │                              │  │  /token            │  │
   2. authorize  │  GET /authorize              │  │  /register  (DCR)  │  │
                 ├─────────────────────────────►│  └─────────┬──────────┘  │
                 │                              │            │             │
                 │  3. Worker redirects browser │            ▼             │
                 │     to Supabase authorize    │  ┌────────────────────┐  │
                 │◄─────────────────────────────┤  │  defaultHandler    │  │
                 │                              │  │  (OAuth client to  │  │
                 │   ┌──────────────────────────┤  │   Voc)             │  │
                 │   │  Voc consent UI          │  └─────────┬──────────┘  │
                 │   │  (Supabase, /oauth/consent│           │             │
                 │   └──────────────────────────┤           │             │
                 │                              │  ┌────────▼───────────┐ │
   4. bearer    │  POST /mcp                   │  │  createMcpHandler  │ │
      token     ├─────────────────────────────►│  │  (6 tools)         │ │
                 │◄─────────────────────────────┤  └────────┬───────────┘ │
                 │                              └───────────┼─────────────┘
                                                            │ Bearer <Voc JWT>
                                        ┌───────────────────▼───────────────────┐
                                        │ Supabase PostgREST + RLS              │
                                        │ records · tags · record_tags          │
                                        │ review_states                         │
                                        └───────────────────────────────────────┘
```

**The Worker plays two OAuth roles simultaneously:**

- **Authorization Server to MCP clients.** `@cloudflare/workers-oauth-provider` implements
  `/authorize`, `/token`, `/register`, discovery metadata, PKCE and token issuance. MCP
  clients see the Worker as *their* AS.
- **OAuth client to Voc.** Inside the provider's `defaultHandler`, the Worker starts a
  *second* authorization-code + PKCE flow against Supabase, ending at a public
  `https://voc-mcp.<account>.workers.dev/callback` redirect URI.

The user therefore consents **twice**: once to the MCP client (Worker-side consent screen),
once to Voc (the existing `/oauth/consent` page). Both are necessary — the first authorises
the client against the Worker, the second authorises the Worker against Voc.

### 3.1 Why stateless, not `McpAgent`

The MCP **2026-07-28** spec removed the `initialize` handshake, the `Mcp-Session-Id` header
and protocol sessions from the core request path. Cloudflare's `McpAgent` (Durable
Object-backed) is **deprecated and feature-frozen**; `createMcpHandler` is the supported
path. Each request arrives, invokes a tool, and returns — no session store, no sticky
routing, no DO migrations. `createMcpHandler` keeps legacy-client compatibility by default
(`era: "modern" | "legacy"`).

### 3.2 Why not call Voc's Nitro API

Architecture rule 1 in [AGENTS.md](../../voc/AGENTS.md#L55-L61) is explicit: *standard CRUD
goes directly from the client to PostgREST*. Voc deliberately has **no record CRUD API** —
records and tags are ordinary tables, so the Worker talks to PostgREST directly, exactly as
the Voc browser client does (§5.1).

The only Nitro routes that exist are the review ones — session, grade and stats. They
authenticate exclusively through the cookie session
([supabase.ts](../../voc/server/utils/supabase.ts)) and reject bearer tokens, so an external
caller cannot reach them while Voc stays untouched (§5.2). That, and not convenience, is what
puts the review loop out of scope (§14 **O5**).

The split, such as it is, follows **semantics, not preference**:

| Upstream | Used for | Why |
|---|---|---|
| PostgREST + RLS | records, tags, `record_tags`, `review_states` bootstrap | plain CRUD; RLS is the authority |
| Voc Nitro | *nothing* | cookie-only; see §5.2 |

---

## 4. Component Layout

```
voc-mcp-server/
├── docs/
│   ├── tech-design.md          # this document
│   └── implementation-plan.md  # task / subtask checklist (§12)
├── src/
│   ├── index.ts                # OAuthProvider wiring + fetch export (Task 3 ships a
│   │                           #   dev-only /mcp wiring until Task 5 lands — see §8)
│   ├── mcp/
│   │   ├── server.ts           # createServer(voc) + tool registration
│   │   ├── tools/
│   │   │   ├── create-record.ts
│   │   │   ├── search-records.ts
│   │   │   ├── get-record.ts
│   │   │   ├── update-record.ts
│   │   │   ├── delete-record.ts
│   │   │   └── list-tags.ts
│   │   └── shared/
│   │       ├── schemas.ts      # Zod input schemas + Voc field limits
│   │       ├── session.ts      # VocSession { client, userId } + factory — the seam
│   │       │                   #   that keeps tools OAuth-free (Task 5 fills it)
│   │       ├── errors.ts       # tool-result error helpers
│   │       └── result.ts       # content[] formatting helpers
│   ├── voc/
│   │   ├── postgrest.ts        # typed PostgREST client (records/tags/record_tags)
│   │   ├── records.ts          # create/fetch/update/delete semantics (mirrors useRecords.ts)
│   │   └── tags.ts             # tag listing + name→id resolution
│   ├── auth/
│   │   ├── handler.ts          # defaultHandler: Worker-as-OAuth-client of Voc
│   │   ├── consent.ts          # Worker-side consent screen (HTML)
│   │   └── token-store.ts      # Voc token custody (KV)
│   └── types/
│       └── env.ts              # Env bindings + secrets
├── test/
│   ├── smoke.spec.ts           # harness canary (Task 1)
│   ├── records.spec.ts
│   ├── search.spec.ts
│   ├── tags.spec.ts
│   ├── tools.spec.ts
│   └── auth.spec.ts
├── wrangler.jsonc
├── package.json
├── pnpm-workspace.yaml         # pnpm 12 build approvals (allowBuilds)
└── tsconfig.json
```

---

## 5. The Voc Surface MCP Uses

### 5.1 Reachable — PostgREST with the user's OAuth JWT

OAuth access tokens issued by Supabase are **standard Supabase JWTs** with `sub` = the
authorizing user's UUID and a `client_id` claim. `auth.uid()` therefore returns the resource
owner and **every existing RLS policy applies unchanged**.

| Operation | Endpoint |
|---|---|
| Create record | `POST /rest/v1/records` (`Prefer: return=representation`) |
| Create tag links | `POST /rest/v1/record_tags` |
| Create review state | `POST /rest/v1/review_states` |
| Search / list | `GET /rest/v1/records?select=*,record_tags(tags(*))` |
| Read one | `GET /rest/v1/records?select=*,record_tags(tags(*))&id=eq.<id>` |
| Update | `PATCH /rest/v1/records?id=eq.<id>` |
| Delete | `DELETE /rest/v1/records?id=eq.<id>` |
| List tags | `GET /rest/v1/tags?select=id,name,is_predefined` |

Every request carries `apikey: <anon key>` and `Authorization: Bearer <Voc access token>`.
**The service-role key is never used, never stored, and never present in this project.**

### 5.2 Unreachable — Voc's cookie-only Nitro routes

Voc has exactly three Nitro routes, and none of them can be reached from the Worker:

| Route | Purpose | Why unreachable |
|---|---|---|
| `GET /api/review/session` | the due review queue | identity resolves from the cookie session only |
| `POST /api/review/grade` | grade + advance the SRS schedule | same |
| `GET /api/stats` | counts, streak, weekly activity | same |

All three call [`requireUserId()`](../../voc/server/utils/supabase.ts), which resolves the
caller through `serverSupabaseUser()` — that is, from the `Cookie` header. There is no
`Authorization` handling anywhere in Voc's server, so a Worker presenting a bearer token is
rejected with `401 Not authenticated`.

This is stated in the design so it is not rediscovered later: **the review loop is out of
scope** (§1). The tempting alternative — pointing the Worker at `review_states` and porting
[srs.ts](../../voc/server/utils/srs.ts) and [stats.ts](../../voc/server/utils/stats.ts) — is
rejected because it would put a **second scheduler** on the same rows. Two implementations
agree on day one and drift the first time `INTERVAL_LADDER` or `PASSES_TO_MASTER` is retuned,
silently corrupting review history. Deferred rather than dismissed: §14 **O5**.

What the Worker *does* do is bootstrap a record's review state on create (§5.3 step 3) — a
plain `INSERT` with no scheduling math involved. Records captured through MCP therefore land
in the user's review queue normally and are reviewed and graded in the Voc UI.

### 5.3 Semantics that must be replicated

Voc's record writes are **not** a single insert — there is no database trigger. The MCP
server must reproduce [useRecords.ts](../../voc/app/composables/useRecords.ts) exactly:

**Create — 3-step composite with rollback:**

1. `INSERT` into `records` (including `user_id` from the JWT `sub` claim).
2. `INSERT` into `record_tags` (only if tags are present).
3. `INSERT` into `review_states` with **no fields** — the row relies on DB defaults
   (`status 'new'`, `interval_days 0`, `next_review_at now()` → due immediately). Omitting
   this step yields a record that never enters the review queue.
4. Any failure after step 1 → `DELETE` the record (FK cascades clean up the rest).

**Update — full field set + tag diff:** the row is `PATCH`ed with the complete
`{type, content, meaning, source, notes}` set, then `record_tags` is diffed — remove only
deselected tags, add only new ones. Never delete-all-then-insert.

**Delete — cascades:** `record_tags`, `review_states` and `review_events` all
`on delete cascade`. **Deleting a record destroys its review history irrecoverably.**

**Search:** `or=(content.ilike.%<term>%,meaning.ilike.%<term>%)` after stripping `,` `(` `)`
from the user's term (PostgREST `or=` syntax injection guard, see `sanitizeSearchTerm`).
Tag filtering is a **two-step union** — resolve record ids from `record_tags` first, then
`id=in.(…)` — because a single `!inner` join duplicates records carrying several matching
tags and breaks the exact count used for pagination.

---

## 6. Tool Surface

Pattern A — one tool per action. Six tools, comfortably under the ~15-tool context budget
([tool-design guidance](https://claude.com/docs/connectors/building/review-criteria)).

Every tool ships `title`, `readOnlyHint` and `destructiveHint`. Read and write operations are
**separate tools** (a directory hard requirement). Descriptions state what the tool does, what
it returns, and what it does *not* do.

### 6.1 `create_record` — write

```ts
{
  type:        z.enum(['word', 'phrase', 'sentence']),
  content:     z.string().trim().min(1).max(500),
  meaning:     z.string().trim().min(1).max(2000),
  source:      z.string().trim().max(500).optional(),
  notes:       z.string().trim().max(4000).optional(),
  tags:        z.array(z.string()).default([]),
}
```

- `title`: "Create vocabulary record"; `readOnlyHint: false`, `destructiveHint: false`
- `type` guidance lives in the parameter description: a single word → `word`, a fixed
  multi-word expression → `phrase`, a full clause with a verb → `sentence`.
- Returns the created record **with its id**, so the assistant can reference or amend it.
- **`tags` are names, not UUIDs** (§6.7).

### 6.2 `search_records` — read

```ts
{
  query:    z.string().optional(),
  type:     z.enum(['word', 'phrase', 'sentence', 'all']).default('all'),
  tags:     z.array(z.string()).default([]),   // union semantics
  sort:     z.enum(['newest', 'oldest', 'alphabetical']).default('newest'),
  page:     z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
}
```

- `title`: "Search vocabulary records"; `readOnlyHint: true`
- Mirrors `RecordListFilters` exactly, including union tag semantics and stable tiebreak on
  `id`.
- Returns `{ records, total, hasMore, page }`. When `total` exceeds what was returned, the
  response says so explicitly so the model narrows rather than assuming completeness.

### 6.3 `get_record` — read

```ts
{ id: z.uuid() }
```

- `title`: "Get vocabulary record"; `readOnlyHint: true`
- Returns the record plus its tags and *review state* (`status`, `next_review_at`) — read-only
  context that helps the assistant avoid re-explaining a mastered word. Returns a structured
  "not found" error pointing at `search_records`.

### 6.4 `update_record` — write

```ts
{
  id:      z.uuid(),
  type:    z.enum(['word', 'phrase', 'sentence']).optional(),
  content: z.string().trim().min(1).max(500).optional(),
  meaning: z.string().trim().min(1).max(2000).optional(),
  source:  z.string().trim().max(500).nullable().optional(),
  notes:   z.string().trim().max(4000).nullable().optional(),
  tags:    z.array(z.string()).optional(),
}
```

- `title`: "Update vocabulary record"; `readOnlyHint: false`, `destructiveHint: false`,
  `idempotentHint: true`
- Omitted field = unchanged. Explicit `null` on `source`/`notes` = clear. `tags` omitted =
  leave associations alone; `tags: []` = remove all.
- Implemented as read-modify-write, because Voc requires the full `{type, content, meaning}`
  set on update and its tag handling is a diff, not a replace.
- Returns nothing about review state — editing does not touch SRS scheduling.

### 6.5 `delete_record` — write, destructive

```ts
{ id: z.uuid() }
```

- `title`: "Delete vocabulary record"; `destructiveHint: true`, `readOnlyHint: false`
- The description warns that review history (`review_events`) is deleted with the record and
  cannot be recovered. The host renders a confirmation dialog from `destructiveHint`.
- Returns a one-line confirmation naming the deleted content.

### 6.6 `list_tags` — read

```ts
{}   // no inputs
```

- `title`: "List tags"; `readOnlyHint: true`
- Returns predefined tags (`work`, `daily`, `idiom`, `travel`) plus the user's custom tags,
  each as `{ name, is_predefined }`. Exists so the assistant can discover valid tag names
  before calling the write tools.

### 6.7 Design note: tag names, not tag UUIDs

The tools accept and return **tag names**, not `tag_id` UUIDs. An assistant cannot know a UUID
before it asks, and forcing `list_tags` → manual id mapping on every write burns context for
no benefit. Resolution happens in `src/voc/tags.ts`: names are matched case-insensitively
against the visible tag set; unknown names produce an error listing the close matches and
suggesting `list_tags`. Silent tag creation is **not** done (see §14 **R2**).

---

## 7. Authentication

### 7.1 Endpoint map

| Path | Owner | Purpose |
|---|---|---|
| `/.well-known/oauth-protected-resource` | Worker | RFC 9728 resource metadata |
| `/.well-known/oauth-authorization-server` | `workers-oauth-provider` | AS metadata, DCR endpoint |
| `/authorize` | `workers-oauth-provider` → `defaultHandler` | Client consent, then Voc redirect |
| `/register` | `workers-oauth-provider` | DCR |
| `/token` | `workers-oauth-provider` | Token issuance to MCP clients |
| `/callback` | `src/auth/handler.ts` | **Voc's** redirect target |
| `/mcp` | `createMcpHandler` | The MCP endpoint (`apiRoute`) |

### 7.2 Sequence

```
MCP client                       Worker                              Supabase (Voc)
──────────                       ──────                              ──────────────
GET /mcp (no token)
  ◄── 401 + WWW-Authenticate ──
GET /.well-known/oauth-authorization-server
  ◄── AS metadata ─────────────
POST /register  (DCR)
  ◄── client_id ───────────────
GET /authorize?client_id=…&redirect_uri=…&code_challenge=…
  ─────────────────────────────►
  ◄── 302 ──────────────────────  302 → Supabase /auth/v1/oauth/authorize
                                    ?client_id=<VOC_CLIENT_ID>
                                    &redirect_uri=<VOC_REDIRECT_URI>
                                    &scope=offline_access
                                    &code_challenge=<PKCE>
       [user signs in and consents at /oauth/consent on Voc]
  ◄── 302 → /callback?code=… ───  Supabase redirects the browser to the Worker
                                   POST /auth/v1/oauth/token
                                   (code + code_verifier, auth method: none)
                                   ◄── access_token + refresh_token
                                   store Voc session in KV (§7.3)
  ◄── 302 → client redirect_uri?code=<Worker code>
POST /token  (code + verifier)
  ◄── Worker access token ──────
POST /mcp  Authorization: Bearer <Worker token>
  ─────────────────────────────►  resolve grant → Voc token → PostgREST (§5.1)
```

### 7.3 Voc token custody

`workers-oauth-provider` encrypts and stores the **grant** returned by `defaultHandler` as
token `props`. Those props are written once and are not mutable, so they **cannot** hold a
rotating refresh token. `props` therefore carries only the stable identity
(`{ voc_user_id, voc_email }`), and the live credential set lives in its own KV namespace:

```
VOC_SESSIONS  (KV)
  key:   <voc_user_id>
  value: { refresh_token, access_token, expires_at, scope }
```

- Requests read the Voc access token; if it expires within 60s, the Worker refreshes it via
  `POST /auth/v1/oauth/token` (`grant_type=refresh_token`) and writes the new pair back.
- `offline_access` is requested at authorize time — without it Supabase issues no refresh
  token and the user would re-consent hourly.
- **If refresh fails** (revoked, expired, user signed out of Voc), the Worker deletes the KV
  entry and returns `401` with a `WWW-Authenticate` challenge so the MCP client re-runs the
  full OAuth flow. This is the only correct recovery; silently returning empty results would
  make the assistant believe the user has no records.
- Supabase refresh tokens **rotate on use**. Concurrent refreshes for the same user can
  invalidate each other. For a single-user deployment this is a negligible race; if it ever
  bites, move custody into a Durable Object keyed by `voc_user_id` so refresh serialises.

Worker-issued access tokens (what the MCP client holds) get a long-ish `accessTokenTTL` —
they gate nothing but the Worker, and the underlying Voc credential is refreshable, so
there is no reason to make the client re-authenticate frequently.

### 7.4 Voc-side registration

Voc's OAuth server has **dynamic client registration disabled** (manual only) and Voc will
not be modified. So, one manual step in Supabase → Authentication → **OAuth Apps**. Two
clients are registered over the course of the build (§14 **R3**):

| # | When | Client name | Type | Redirect URI |
|---|---|---|---|---|
| 1 | Task 4 — local | `Voc MCP Server (dev)` | `public` (`none`) | `http://localhost:8787/callback` |
| 2 | Task 7 — deployed | `Voc MCP Server` | `public` (`none`) | `https://voc-mcp.<account>.workers.dev/callback` |

Redirect URIs must match **exactly** — no wildcards. `wrangler dev` serves on port 8787 by
default, so pin the dev port so the registered URI stays valid.

The existing test client `9b5a1ba3-4b09-4e45-9e92-279bfd401555` is **not** reusable: its
registered redirect URI is `http://localhost:3000/callback` and it belongs to the Voc OAuth
work, not this server. Keep them separate so revoking one does not break the other.

### 7.5 Scopes

Request `offline_access` only. Data access is governed by RLS, not scopes, and the
`openid`/`email`/`profile` scopes only shape UserInfo claims — they buy nothing here. (Note
that `/oauth/consent` will therefore render with no human-readable scope list; the consent
copy on the MCP side should explain what access is being granted.)

---

## 8. Worker Configuration

### `wrangler.jsonc`

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "voc-mcp-server",
  "main": "src/index.ts",
  // 2026-08-22, not 2026-09-01: @cloudflare/vitest-pool-workers 0.22.0 pins
  // miniflare 5.20260815.0-alpha, whose runtime accepts no later date. Dev, test
  // and deploy share one date; bump it when pool-workers ships a newer runtime.
  "compatibility_date": "2026-08-22",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "kv_namespaces": [
    { "binding": "OAUTH_KV",     "id": "<workers-oauth-provider KV>" },
    { "binding": "VOC_SESSIONS", "id": "<voc token custody KV>" }
  ],
  "vars": {
    "VOC_SUPABASE_URL": "https://mqehfyrkgyzodlqwkozf.supabase.co",
    "VOC_OAUTH_CLIENT_ID": "<client_id from OAuth Apps>",
    "VOC_REDIRECT_URI": "https://voc-mcp.<account>.workers.dev/callback"
  }
}
```

No Durable Object block and no `migrations` — the server is stateless. No service-role key
binding exists in this project by design.

**Secrets (never in `wrangler.jsonc` vars):** `VOC_SUPABASE_ANON_KEY` — the anon
(publishable) key sent as `apikey` on every PostgREST call (§5.1). Held in `.dev.vars`
locally (gitignored) and via `wrangler secret put` at deploy. Unit tests inject a stubbed
fetch, so they never need the real value.

### Dependencies

| Package | Role |
|---|---|
| `agents` | provides `createMcpHandler` (`agents/mcp/server`) |
| `@modelcontextprotocol/server@2.0.0` | MCP SDK v2 — `McpServer`, tool registration (pin exact) |
| `@cloudflare/workers-oauth-provider` | AS to MCP clients: discovery, DCR, PKCE, tokens |
| `zod` | tool input schemas, shared with Voc's field limits |

Dev: `wrangler`, `typescript`, `@cloudflare/workers-types`, `vitest`,
`@cloudflare/vitest-pool-workers`, `@modelcontextprotocol/client` (drives
`test/tools.spec.ts` over `InMemoryTransport` — the same path MCP Inspector takes).

### `src/index.ts` (shape)

```ts
import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { createMcpHandler } from 'agents/mcp/server'
import { createServer } from './mcp/server'
import { vocAuthHandler } from './auth/handler'

export default new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: createMcpHandler(createServer),
  defaultHandler: vocAuthHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  accessTokenTTL: 60 * 60 * 24 * 30,
})
```

The `createMcpHandler` factory receives the request context
(`{ era, authInfo, requestInfo }`). `authInfo.props` carries `voc_user_id`, which the tools
use to load the Voc credential from `VOC_SESSIONS`. **Identity comes from `authInfo`, never
from a tool argument** — no tool accepts a `user_id`, mirroring Voc's architecture rule 4.

> **Task 3 interim wiring (dev-only):** until Task 5 lands, `src/index.ts` ships a plain
> fetch export without the OAuthProvider. On `/mcp` the bearer token is used **directly as
> the caller's Voc JWT** and `userId` is its `sub` claim, decoded without verification.
> This exists so the six tools are runnable and Inspectable before OAuth exists
> (implementation-plan Task 3); it is scaffolding, replaced wholesale by the shape above.

---

## 9. Error Handling

Errors are returned as MCP tool results (`isError: true`), never thrown into the transport.
Every message names a next step:

| Situation | Message shape |
|---|---|
| Record not found / RLS-invisible | `"Record <id> not found. Use search_records to find valid ids."` |
| Unknown tag name | `"Unknown tag 'travels'. Known tags: travel, work, …. Use list_tags to list all."` |
| Voc session expired | `isError: true`, plus a 401 so the client re-authenticates |
| PostgREST 4xx/5xx | Status + PostgREST `message`/`details`, not a raw dump |
| Partial create failure | Rollback attempted; report which step failed and that nothing was saved |

PostgREST returns `200` with `[]` for an RLS-invisible read, and `PGRST116` for a
zero-row `.single()`. Both are mapped to the explicit not-found message above — an empty
result must never be reported as "the user has no records".

---

## 10. Security Considerations

- **No service-role key anywhere in this project.** All data access is user-bound and
  RLS-filtered. This is Voc architecture rule 3 extended to the Worker.
- **No token passthrough.** The MCP client's bearer token is the *Worker's* token; the Voc
  JWT is the Worker's own upstream credential, obtained through its own OAuth flow. The
  client's token is never forwarded to Supabase. (MCP spec explicitly forbids passthrough.)
- **Consent screen on the Worker side.** Before redirecting upstream, the Worker shows its
  own consent dialog, with CSRF protection via a `__Host-CSRF_TOKEN` cookie and output
  escaping of the client-supplied `client_name` / `logo_uri`. Without this, a malicious
  client could exploit cached upstream consent (confused-deputy).
- **`voc_user_id` comes from `authInfo.props`**, written by the Worker after verifying
  Supabase's token — not from anything the client sends.
- **KV entries are encrypted at rest by Cloudflare**, and grants are encrypted by the library.
  Refresh tokens are the sensitive payload; never log them, never put them in a tool result.
- **Narrow RLS surface:** the Worker can read/write the same rows the Voc app can. Deleting a
  record destroys review history — hence `destructiveHint: true`.
- **`allowedHostnames`** on `createMcpHandler` restricts the accepted `Host` header;
  set it to the deployment hostname to harden against DNS rebinding.
- Supabase's OAuth server is **beta** — the design accepts that risk, consistent with Voc's
  own OAuth decisions.

---

## 11. Testing Plan

**Unit (Vitest, no network):**

- `src/voc/records.ts` against a stubbed PostgREST: the 3-step create including rollback on
  step-2/step-3 failure; tag diff on update; cascade-delete call shape.
- Search filter construction — notably that `,` `(` `)` are stripped from the term, and that
  tag filtering issues the two-step union rather than an `!inner` join.
- Tag name resolution: case-insensitivity, predefined + custom union, unknown-name error.
- Zod schema rejection at Voc's exact boundaries (content 501 chars, meaning 2001, etc.).
- `test/tools.spec.ts` — the six tools over `InMemoryTransport` + MCP `Client`:
  tools/list surface (names, titles, §6 annotations, no `user_id` input), a happy path per
  tool, and the §9 error shapes (structured not-found, unknown tag with close matches,
  PostgREST failure as an `isError` result).

**Integration (`@cloudflare/vitest-pool-workers`):**

- OAuth metadata documents are well-formed; `/register` returns a usable client.
- A full PKCE code exchange against a mocked Supabase, asserting the stored session lands in
  `VOC_SESSIONS` and that props contain `voc_user_id` but **no** refresh token.
- Refresh-on-expiry path; refresh-failure path returns 401 + `WWW-Authenticate`.
- `/mcp` rejects a missing/foreign bearer token.

**End-to-end (manual, against real Voc):**

1. `wrangler dev` on a stable hostname; register that callback URI in Voc's OAuth Apps.
2. Add the local URL as a custom connector in Claude, complete both consents.
3. `create_record` → verify the row appears in the Voc UI **and that it is due for review**
   (this is the assertion that catches a missing `review_states` insert).
4. `search_records` with a tag filter and with a `,()`-laden query.
5. `update_record` changing tags; `delete_record`; confirm cascade removed the review state.
6. Wait past Voc's token TTL (1h) and confirm a tool call still succeeds via refresh.
7. Revoke the Voc session and confirm the client is re-challenged rather than seeing empty
   results.

---

## 12. Implementation Plan

The build is broken into tasks and subtasks with explicit exit criteria in
[implementation-plan.md](implementation-plan.md) — seven tasks, no changes to the `voc`
repository. Task 4 and Task 7 each involve one manual client registration in Supabase →
OAuth Apps (§7.4, §14 **R3**); everything else is code in this repo.

---

## 13. Explicit Non-Goals

- **Review sessions, grading, SRS scheduling, streaks, stats.** These live behind Voc's
  cookie-only Nitro routes, which this server cannot call without modifying Voc (§5.2). Voc
  keeps sole ownership of the scheduler; the Worker only bootstraps a new record's
  `review_states` row so it enters the queue. See §14 **O5**.
- Tag creation and deletion.
- Bulk import / export, file upload, TTS.
- Resources, prompts, elicitation, sampling — tools only. Nothing here needs mid-call user
  input; the one place it might (`delete_record` confirmation) is better served by
  `destructiveHint`.
- MCP app / interactive widgets.

---

## 14. Decisions

### Resolved during review

**R1 — CIMD is not supported by `@cloudflare/workers-oauth-provider` → ship DCR-only.**
Decision #5 originally asked for "DCR + CIMD". The Cloudflare provider library implements DCR,
PKCE and discovery but **not** CIMD (`client_id_metadata_document_supported`), and neither the
library nor the Cloudflare Agents docs advertise it.

**Resolution:** ship DCR-only. MCP clients negotiate in the order pre-registered → CIMD → DCR,
so every current client registers successfully through DCR — CIMD would simply never be
offered, and nothing is lost today. Revisit if the library adds CIMD support, or if a client
appears that refuses DCR. Hand-rolling a CIMD shim against an unsupported extension point and
moving the AS to a third-party provider (WorkOS / Auth0) were both rejected as disproportionate
for a personal server.

**R2 — Unknown tag names error with a hint; no implicit tag creation.**
`create_record` / `update_record` / `search_records` match tag names case-insensitively against
the visible tag set. An unmatched name returns an error listing the known tags and pointing at
`list_tags`. Nothing is mutated without intent, which keeps near-duplicate tags
(`travel` / `Travel` / `travelling`) out of the user's tag list. Auto-creation was rejected as
too surprising; a dedicated `create_tag` tool remains available to add later if the friction
turns out to be real.

**R3 — The Worker's callback URI is registered twice.**
Voc's redirect URIs are exact-match and Voc's DCR is off, so the Worker's callback must be
registered manually. The build sequence therefore registers **two** clients in Supabase →
OAuth Apps:

| # | When | Redirect URI |
|---|---|---|
| 1 | Task 4, local development | the `wrangler dev` origin (e.g. `http://localhost:8787/callback`) |
| 2 | Task 7, after `wrangler deploy` | `https://voc-mcp.<account>.workers.dev/callback` |

This keeps local development unblocked rather than waiting on a final hostname. Attaching a
custom domain and registering once remains a reasonable later cleanup.

**R4 — Voc stays untouched: the review loop is out of scope.**
Decision #7 reads "no changes to the Voc codebase", and it holds. `GET /api/review/session`,
`POST /api/review/grade` and `GET /api/stats` authenticate only through the cookie session and
reject bearer tokens (§5.2), so the review tools cannot exist without modifying Voc. An earlier
revision accepted that change (~35–40 lines in Voc's single auth choke point, plus a Voc
deploy); it was withdrawn because the goal — capture and curate vocabulary — does not require
it. The rejected shortcut, porting `srs.ts` + `stats.ts` into the Worker, is rejected again in
§5.2. The capability is deferred rather than dismissed: **O5**.

### Still open

**O4 — Tool response verbosity.**
`search_records` returns full records (content, meaning, source, notes, tags). With `pageSize`
20 and long notes this can be a large payload. Options: a `fields` projection parameter, or a
compact default with `get_record` for detail. Recommend leaving it as-is until real usage shows
a problem — it is easy to change later and adds context cost now.

**O5 — Review, grading and stats tools (deferred).**
`get_review_queue`, `grade_record` and `get_stats` are not in this build (§1, §13). The
capability is real — "what's due today?", "mark this one as known" is a natural extension of
the six tools — but it is blocked by an authentication boundary, not by effort. Reaching it
requires one of:

| Route to unblock | What it costs |
|---|---|
| Add bearer support to Voc's `requireUserId` / `getRequestSupabase` | ~35–40 lines in Voc plus a deploy, and a second auth path through the file the browser, SSR and OAuth-provider flows all depend on |
| Port `srs.ts` + `stats.ts` into the Worker | ~200 lines, and **two schedulers on the same `review_states` rows** — rejected outright (§5.2) |
| Expose the three routes under a new auth scheme in Voc | Largest change of the three; only worth it if the review loop becomes a primary use case |

Until one is chosen, records captured through MCP still enter the review queue normally
(§5.3 step 3) and are reviewed in the Voc UI — nothing is lost, only the AI-side loop is
absent. Revisit when usage shows the user actually asking the assistant to review or grade.

---

## 15. References

**Voc (upstream)**

- [tech-design.md](../../voc/docs/tech-design.md) — overall architecture
- [oauth-provider-tech-design.md](../../voc/docs/oauth-provider-tech-design.md) — Voc as an OAuth provider
- [4.2-oauth-server-config.md](../../voc/docs/4.2-oauth-server-config.md) — live Supabase OAuth config, JWKS/ES256, test client
- [AGENTS.md](../../voc/AGENTS.md) — the five architecture rules this design defers to
- [001_initial_schema.sql](../../voc/supabase/migrations/001_initial_schema.sql) — schema, RLS, cascades
- [useRecords.ts](../../voc/app/composables/useRecords.ts) — the write semantics being replicated
- [supabase.ts](../../voc/server/utils/supabase.ts) — `requireUserId`, the cookie-only auth boundary of §5.2
- [srs.ts](../../voc/server/utils/srs.ts) — the scheduler that stays in Voc, unported (O5)

**MCP & Cloudflare**

- [MCP handler APIs (`createMcpHandler`)](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [Migrate to MCP SDK v2](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/)
- [Securing MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/)
- [The next generation of MCP](https://blog.cloudflare.com/mcp-v2) — stateless MCP 2026-07-28
- [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
- [MCP connector review criteria](https://claude.com/docs/connectors/building/review-criteria)

**Supabase**

- [OAuth 2.1 Server](https://supabase.com/docs/guides/auth/oauth-server)
- [Token Security & RLS](https://supabase.com/docs/guides/auth/oauth-server/token-security)
