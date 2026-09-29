import { createMcpHandler } from 'agents/mcp/server'
import { createServer } from './mcp/server'
import type { VocSessionFactory } from './mcp/shared/session'
import { PostgrestClient } from './voc/postgrest'
import type { Env } from './types/env'

/**
 * DEV IDENTITY (Task 3 only): on `/mcp`, the bearer token is used directly
 * as the caller's Voc JWT and `userId` is read from its `sub` claim without
 * verification. This exists so the tool surface is runnable and Inspectable
 * before OAuth exists (implementation-plan Task 3). Task 5 replaces this
 * wiring with the OAuthProvider of §8 — authInfo.props → VOC_SESSIONS KV →
 * token refresh — and this shortcut disappears.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname !== '/mcp') {
      return Response.json({ ok: true, name: 'voc-mcp-server', version: '0.1.0' })
    }

    const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!token) {
      // Dev-mode challenge; Task 5 replaces this with the OAuth challenge.
      return new Response(
        'Paste a Voc JWT as the bearer token (dev mode until OAuth is wired in Task 5).\n',
        { status: 401 },
      )
    }

    const voc: VocSessionFactory = async () => ({
      client: new PostgrestClient({
        baseUrl: env.VOC_SUPABASE_URL,
        anonKey: env.VOC_SUPABASE_ANON_KEY,
        token,
      }),
      userId: decodeJwtSub(token),
    })

    // The request context carries authInfo only under the Task 5 OAuth
    // provider; the dev factory below closes over the bearer token instead.
    const handler = createMcpHandler(() => createServer(voc))
    return handler(request, env, ctx)
  },
}

/** Dev-only: extract `sub` from a Supabase JWT payload (no verification). */
function decodeJwtSub(token: string): string {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof payload.sub === 'string' && payload.sub) return payload.sub
  } catch {
    // fall through to the explicit error
  }
  throw new Error(
    'The bearer token is not a Voc JWT (no sub claim). Paste a Voc access token in dev mode.',
  )
}
