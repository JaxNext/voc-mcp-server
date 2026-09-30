// The Worker entry: the OAuthProvider of §8 wraps the MCP endpoint.
//
// Two OAuth roles live in this one Worker (§3):
//   • To MCP clients the Worker is an Authorization Server — discovery, DCR,
//     PKCE, /token — owned by `@cloudflare/workers-oauth-provider` (this file).
//   • Inside that provider's `defaultHandler` the Worker is a client of Voc
//     (src/auth/handler.ts, Task 4).
// The user therefore consents twice: once to the MCP client here, once at Voc.
//
// `/mcp` is the provider's `apiRoute`. The provider authenticates the client's
// bearer token, decrypts the grant, attaches its props to `ctx.props`, and only
// then hands the request to the handler below. Identity (`voc_user_id`) is read
// from those props; the live Voc credential is loaded — and refreshed when it is
// about to expire — from VOC_SESSIONS (src/auth/refresh.ts). Neither the identity
// nor the credential is ever a tool argument (§8, §10).
//
// The refresh/expiry preflight runs here, *before* the MCP handler, so an
// unusable Voc session becomes a real `401` + `WWW-Authenticate` (§7.3). A tool
// cannot do that: tools turn every error into an `isError` result (§9).
//
// `src/index.ts` re-exports only this default: workerd validates the entry
// module's named exports as worker entrypoints, so every other value lives here.

import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { createMcpHandler } from 'agents/mcp/server'
import { vocAuthHandler, type VocGrantProps } from './auth/handler'
import { loadVocSession, VocSessionExpiredError } from './auth/refresh'
import type { VocTokenSession } from './auth/token-store'
import { createServer } from './mcp/server'
import type { Env } from './types/env'
import { PostgrestClient } from './voc/postgrest'

/**
 * The MCP client's token gates nothing but this Worker — the real credential is
 * the Voc token in KV — so it is issued for 30 days (§7.3). Refresh tokens are
 * the provider default (30 days).
 */
const ACCESS_TOKEN_TTL = 60 * 60 * 24 * 30

/**
 * The provider sets `ctx.props` from the decrypted grant immediately before it
 * dispatches the api handler (workers-oauth-provider 1.1.0). The global
 * `ExecutionContext` type does not carry props, hence the cast.
 */
type ProviderContext = ExecutionContext & { props?: Partial<VocGrantProps> }

export interface VocApiHandlerOptions {
  /** Injectable for tests; reaches both the Voc refresh and the PostgREST client. */
  fetchImpl?: typeof fetch
}

/**
 * The RFC 9728 protected-resource identifier for one request is that request's
 * own origin: `http://localhost:8787` under `wrangler dev`,
 * `https://<worker>.<account>.workers.dev` in production. Deriving it — rather
 * than hardcoding it per environment — is what lets one artifact serve both,
 * and it mirrors the library's own `getAuthorizationServerIssuer(requestUrl)`.
 * The provider accepts plain http only on a loopback host, so the dev origin is
 * valid too.
 */
function originOf(request: Request): string {
  return new URL(request.url).origin
}

/**
 * The protected handler. It must be an *object* exposing `fetch`: the provider
 * validates `apiHandler` as an `ExportedHandler` (a bare function fails that
 * check) and dispatches with `fetch(request, env, ctx)` — `ctx` carries the
 * grant props the provider decrypted.
 *
 * Before dispatching it resolves the Voc session: identity from `ctx.props`,
 * credential from VOC_SESSIONS with refresh-on-expiry. A missing identity or an
 * unusable credential returns `401` + `WWW-Authenticate` so the client
 * re-authenticates — never an empty tool result (§7.3, §9).
 */
export function createVocApiHandler(options: VocApiHandlerOptions = {}) {
  const doFetch = options.fetchImpl ?? fetch
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const origin = originOf(request)
      const userId = (ctx as ProviderContext).props?.voc_user_id
      if (typeof userId !== 'string' || userId === '') {
        return bearerChallenge(origin)
      }

      let session: VocTokenSession
      try {
        session = await loadVocSession(env, userId, Math.floor(Date.now() / 1000), doFetch)
      } catch (error) {
        if (error instanceof VocSessionExpiredError) {
          return bearerChallenge(origin)
        }
        throw error
      }

      // No `allowedHostnames`: the MCP SDK then applies its own default — the
      // loopback set under `wrangler dev`, the request hostname on
      // `*.workers.dev` — so the same artifact is correctly host-validated in
      // both places (§10).
      const handler = createMcpHandler(() =>
        createServer(async () => ({
          client: new PostgrestClient({
            baseUrl: env.VOC_SUPABASE_URL,
            anonKey: env.VOC_SUPABASE_ANON_KEY,
            token: session.access_token,
            fetchImpl: doFetch,
          }),
          userId,
        })),
      )
      return handler(request, env, ctx)
    },
  }
}

export const vocApiHandler = createVocApiHandler()

/**
 * RFC 6750 challenge for an unusable Voc session. Mirrors the provider's own
 * 401 shape (`createBearerChallenge`) so a client treats an expired Voc grant
 * exactly like a missing Worker token: re-run discovery → authorize → token.
 */
function bearerChallenge(resource: string): Response {
  return new Response(null, {
    status: 401,
    headers: {
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'WWW-Authenticate': `Bearer realm="OAuth", resource_metadata="${resource}/.well-known/oauth-protected-resource"`,
    },
  })
}

/**
 * One provider instance per origin. `OAuthProvider` bakes its
 * `resourceMetadata.resource` in at construction and validates it then, so an
 * origin-dependent `resource` means an origin-dependent instance. Real traffic
 * only ever has one origin per deployment, so memoising the last origin makes
 * this a single construction in practice. (`RESOURCE`/`ALLOWED_HOSTNAMES`
 * module constants were removed in Task 7 for exactly this reason: a static
 * value cannot be right in both `wrangler dev` and production.)
 */
let cachedProvider: { origin: string; provider: OAuthProvider<Env> } | undefined

function providerFor(origin: string): OAuthProvider<Env> {
  if (cachedProvider?.origin === origin) return cachedProvider.provider
  const provider = new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: vocApiHandler,
    defaultHandler: vocAuthHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    accessTokenTTL: ACCESS_TOKEN_TTL,
    // Required by workers-oauth-provider 1.1.0 (RFC 9728 protected-resource
    // metadata served at /.well-known/oauth-protected-resource); the provider
    // throws at construction without it. DCR only — CIMD stays disabled
    // (§14 R1).
    resourceMetadata: { resource: origin, resource_name: 'voc-mcp-server' },
  })
  cachedProvider = { origin, provider }
  return provider
}

// The entry module's default export: dispatch to the provider for this
// request's origin. A bare `OAuthProvider` instance cannot be the default
// export any more, because which instance to use depends on the request.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(originOf(request)).fetch(request, env, ctx)
  },
}
