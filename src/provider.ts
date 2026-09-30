// The Worker entry: the OAuthProvider of §8 wraps the MCP endpoint.
//
// Two OAuth roles live in this one Worker (§3):
//   • To MCP clients the Worker is an Authorization Server — discovery, DCR,
//     PKCE, /token — owned by `@cloudflare/workers-oauth-provider` (this file).
//   • Inside that provider's `defaultHandler` the Worker is a client of Voc
//     (src/auth/handler.ts, Task 4).
// The user therefore consents twice: once to the MCP client here, once at Voc.
//
// `/mcp` is the provider's `apiRoute`: the provider authenticates the client's
// bearer token, resolves the grant props, and only then hands the request to
// the MCP handler below. Identity (`voc_user_id`) reaches the tools through
// `getMcpAuthContext().props`; the live Voc credential is loaded from
// VOC_SESSIONS keyed by that id — never from a tool argument (§8, §10).
//
// `src/index.ts` re-exports only this default: workerd validates the entry
// module's named exports as worker entrypoints, so every other value lives here.

import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { createMcpHandler, getMcpAuthContext } from 'agents/mcp/server'
import { vocAuthHandler } from './auth/handler'
import { getVocSession } from './auth/token-store'
import { createServer } from './mcp/server'
import type { VocSessionFactory } from './mcp/shared/session'
import type { Env } from './types/env'
import { PostgrestClient } from './voc/postgrest'

/**
 * RFC 9728 protected-resource identifier (the provider's `resource` and the
 * token audience). Dev value: `wrangler dev` / localhost:8787, accepted because
 * the provider allows plain http on a loopback host. Task 7 replaces this with
 * the deployed `https://voc-mcp.<account>.workers.dev` origin (§7.4).
 */
export const RESOURCE = 'http://localhost:8787'

/**
 * Hosts accepted on `/mcp` (DNS-rebinding hardening, §10). Dev value; Task 7
 * replaces it with the deployment hostname.
 */
export const ALLOWED_HOSTNAMES = ['localhost']

/**
 * The MCP client's token gates nothing but this Worker — the real credential is
 * the Voc token in KV — so it is issued for 30 days (§7.3). Refresh tokens are
 * the provider default (30 days).
 */
const ACCESS_TOKEN_TTL = 60 * 60 * 24 * 30

/**
 * Builds the per-request Voc session from the authenticated identity (§8):
 * `voc_user_id` from the grant props the provider attached to the request, and
 * the credential set from VOC_SESSIONS. A missing either is an explicit error,
 * never an empty result — the tools turn it into an `isError` result (§7.3, §9).
 */
export function createVocSessionFactory(env: Env): VocSessionFactory {
  return async () => {
    const props = getMcpAuthContext()?.props
    const userId = props?.voc_user_id
    if (typeof userId !== 'string' || userId === '') {
      throw new Error('No Voc identity on this request. Reconnect the MCP client to Voc.')
    }
    const session = await getVocSession(env.VOC_SESSIONS, userId)
    if (!session) {
      throw new Error('No stored Voc credential for this user. Reconnect the MCP client to Voc.')
    }
    return {
      client: new PostgrestClient({
        baseUrl: env.VOC_SUPABASE_URL,
        anonKey: env.VOC_SUPABASE_ANON_KEY,
        token: session.access_token,
      }),
      userId,
    }
  }
}

/**
 * The protected handler. It must be an *object* exposing `fetch`: the provider
 * validates `apiHandler` as an `ExportedHandler` (a bare function fails that
 * check) and dispatches with `fetch(request, env, ctx)`. The three arguments
 * matter — `ctx` carries the grant props the provider decrypts, which the MCP
 * handler surfaces through `getMcpAuthContext()`.
 */
export const vocApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const handler = createMcpHandler(() => createServer(createVocSessionFactory(env)), {
      allowedHostnames: ALLOWED_HOSTNAMES,
    })
    return handler(request, env, ctx)
  },
}

export default new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: vocApiHandler,
  defaultHandler: vocAuthHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  accessTokenTTL: ACCESS_TOKEN_TTL,
  // Required by workers-oauth-provider 1.1.0 (RFC 9728 protected-resource
  // metadata served at /.well-known/oauth-protected-resource); the provider
  // throws at construction without it. DCR only — CIMD stays disabled (§14 R1).
  resourceMetadata: { resource: RESOURCE, resource_name: 'voc-mcp-server' },
})
