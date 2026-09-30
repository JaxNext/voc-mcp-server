// The Worker as an OAuth CLIENT of Voc (tech-design §3, §7.2, §7.4).
//
// This is the OAuthProvider's `defaultHandler`. It owns /authorize (consent to
// the MCP client), the second hop to Supabase's authorize endpoint, and
// /callback (Voc's redirect target), where the code is exchanged and the
// credential set lands in VOC_SESSIONS (§7.3). Grant props carry only
// { voc_user_id, voc_email } — props are write-once and cannot hold a rotating
// refresh token.
//
// Public client: no client secret exists. The code exchange authenticates with
// `client_id` + `code_verifier` (PKCE S256); auth method "none".
//
// Supabase calls are routed through an injectable fetchImpl so tests drive the
// whole flow against a stub (§11) — no network.

import {
  AuthorizationError,
  type AuthRequest,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { putVocSession, type VocTokenSession } from './token-store'
import type { Env } from '../types/env'
import {
  CSRF_COOKIE,
  csrfCookieHeader,
  parseCookies,
  randomToken,
  renderConsentPage,
  renderErrorPage,
} from './consent'

/** Stable identity stored in (write-once) grant props — never tokens (§7.3). */
export interface VocGrantProps {
  voc_user_id: string
  voc_email: string | null
}

/** The only scope requested from Voc — without it there is no refresh token (§7.5). */
export const VOC_SCOPE = 'offline_access'

/** Data carried across the Supabase redirect inside the provider's upstream state. */
interface UpstreamData {
  codeVerifier: string
}

/** Env as the OAuthProvider hands it to defaultHandler. */
type AuthEnv = Env & { OAUTH_PROVIDER?: OAuthHelpers }

export interface VocAuthHandlerOptions {
  /** Injectable for tests; defaults to the Workers global fetch. */
  fetchImpl?: typeof fetch
}

export function createVocAuthHandler(options: VocAuthHandlerOptions = {}) {
  const doFetch = options.fetchImpl ?? fetch
  return {
    async fetch(request: Request, env: AuthEnv): Promise<Response> {
      const oauth = env.OAUTH_PROVIDER
      if (!oauth) {
        return errorResponse(
          500,
          'OAuth layer missing',
          'This handler must be reached through the OAuthProvider wiring (Task 5).',
        )
      }
      const url = new URL(request.url)
      if (url.pathname === '/authorize' && request.method === 'GET') {
        return authorize(request, oauth)
      }
      if (url.pathname === '/authorize/consent' && request.method === 'POST') {
        return consent(request, env, oauth)
      }
      if (url.pathname === '/callback') {
        return callback(request, env, oauth, doFetch)
      }
      return errorResponse(404, 'Not found', 'Connect from your MCP client; it will land on /authorize.')
    },
  }
}

export const vocAuthHandler = createVocAuthHandler()

// ---------------------------------------------------------------------------
// /authorize — parse the MCP client's request, render the consent screen.
// ---------------------------------------------------------------------------

async function authorize(request: Request, oauth: OAuthHelpers): Promise<Response> {
  let authRequest: AuthRequest
  let clientName: string
  let logoUri: string | undefined
  try {
    authRequest = await oauth.parseAuthRequest(request)
    const client = await oauth.lookupClient(authRequest.clientId)
    if (!client) {
      return errorResponse(
        400,
        'Unknown client',
        `Client ${authRequest.clientId} is not registered. The MCP client must register first (/register).`,
      )
    }
    clientName = client.clientName ?? authRequest.clientId
    logoUri = client.logoUri
  } catch (error) {
    return errorResponse(400, 'Invalid authorization request', describe(error))
  }

  const { handle, headers } = await oauth.beginConsent(authRequest)
  // Double-submit CSRF: one token, in both the cookie and the hidden form field.
  const csrfToken = randomToken()
  const response = new Response(
    renderConsentPage({
      clientName,
      logoUri,
      scopes: authRequest.scope,
      csrfToken,
      handle,
    }),
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
  copySetCookies(response.headers, headers)
  response.headers.append('Set-Cookie', csrfCookieHeader(csrfToken))
  return response
}

// ---------------------------------------------------------------------------
// POST /authorize/consent — approve or deny; approve chains into the Voc hop.
// ---------------------------------------------------------------------------

async function consent(request: Request, env: AuthEnv, oauth: OAuthHelpers): Promise<Response> {
  const form = await request.formData()
  const handle = String(form.get('handle') ?? '')
  const csrf = String(form.get('csrf') ?? '')
  const decision = String(form.get('decision') ?? '')

  const cookies = parseCookies(request.headers.get('Cookie'))
  if (!csrf || csrf !== cookies[CSRF_COOKIE]) {
    return errorResponse(403, 'CSRF check failed', 'Reload the connection page from your MCP client and try again.')
  }

  try {
    if (decision === 'deny') {
      const denied = await oauth.denyConsent(request, handle)
      return redirectResponse(denied.redirectTo, denied.headers)
    }
    const approved = await oauth.approveConsent(request, handle)
    const { codeVerifier, codeChallenge } = await createPkcePair()
    // The verifier rides the provider's encrypted upstream state and comes
    // back at /callback; the state is what ties Voc's redirect to this flow.
    const upstream = await oauth.beginUpstream(approved.request, {
      data: { codeVerifier },
      headers: approved.headers,
    })
    return redirectResponse(buildAuthorizeUrl(env, codeChallenge, upstream.state), upstream.headers)
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return errorResponse(400, 'Consent session expired', 'Restart the connection from your MCP client.')
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// /callback — Voc's redirect target: exchange the code, take custody, grant.
// ---------------------------------------------------------------------------

async function callback(
  request: Request,
  env: AuthEnv,
  oauth: OAuthHelpers,
  doFetch: typeof fetch,
): Promise<Response> {
  const url = new URL(request.url)
  let authRequest: AuthRequest
  let codeVerifier: string
  let headers: Headers
  try {
    const resumed = await oauth.finishUpstream<UpstreamData>(request)
    authRequest = resumed.request
    codeVerifier = resumed.data.codeVerifier
    headers = resumed.headers
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return errorResponse(400, 'Authorization session expired or replayed', 'Restart the connection from your MCP client.')
    }
    throw error
  }

  const upstreamError = url.searchParams.get('error')
  if (upstreamError) {
    const detail = url.searchParams.get('error_description') ?? upstreamError
    return errorResponse(
      400,
      'Voc authorization was not granted',
      `${detail}. Restart the connection from your MCP client and approve access at Voc.`,
    )
  }
  const code = url.searchParams.get('code')
  if (!code) {
    return errorResponse(400, 'Voc sent no authorization code', 'Restart the connection from your MCP client.')
  }

  try {
    const tokens = await exchangeCodeForTokens(env, code, codeVerifier, doFetch)
    const identity = decodeVocIdentity(tokens.accessToken)
    await putVocSession(env.VOC_SESSIONS, identity.voc_user_id, toVocSession(tokens, Math.floor(Date.now() / 1000)))
    const { redirectTo } = await oauth.completeAuthorization({
      request: authRequest,
      userId: identity.voc_user_id,
      metadata: {},
      scope: authRequest.scope,
      props: identity,
    })
    return redirectResponse(redirectTo, headers)
  } catch (error) {
    if (error instanceof VocAuthError) {
      // A Voc-side failure must never look like success with empty data — the
      // browser gets an explicit recovery page (§7.3, §9).
      return errorResponse(
        error.status >= 500 ? 502 : 400,
        'Voc sign-in failed',
        `${error.message} Restart the connection from your MCP client.`,
      )
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Supabase (Voc) token exchange + identity.
// ---------------------------------------------------------------------------

export interface VocTokenResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scope: string | null
}

export class VocAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'VocAuthError'
  }
}

/**
 * Exchange the authorization code at `POST /auth/v1/oauth/token` (§7.2).
 * Public client — `client_id` + `code_verifier`, no secret (auth method "none").
 */
export async function exchangeCodeForTokens(
  env: Pick<Env, 'VOC_SUPABASE_URL' | 'VOC_OAUTH_CLIENT_ID' | 'VOC_REDIRECT_URI'>,
  code: string,
  codeVerifier: string,
  doFetch: typeof fetch = fetch,
): Promise<VocTokenResponse> {
  let res: Response
  try {
    res = await doFetch(`${env.VOC_SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: env.VOC_OAUTH_CLIENT_ID,
        redirect_uri: env.VOC_REDIRECT_URI,
        code_verifier: codeVerifier,
        auth_method: 'none',
      }).toString(),
    })
  } catch (error) {
    throw new VocAuthError(502, `Could not reach Voc (${describe(error)}).`)
  }

  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const detail =
      typeof body?.error_description === 'string'
        ? body.error_description
        : typeof body?.message === 'string'
          ? body.message
          : `HTTP ${res.status}`
    throw new VocAuthError(res.status, `Voc rejected the code exchange: ${detail}.`)
  }

  const accessToken = body?.access_token
  const refreshToken = body?.refresh_token
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new VocAuthError(502, 'Voc sent no access token.')
  }
  if (typeof refreshToken !== 'string' || !refreshToken) {
    // offline_access was requested at authorize time; without a refresh token
    // the user would have to re-consent every hour (§7.3) — refuse loudly.
    throw new VocAuthError(502, 'Voc issued no refresh token (offline_access was not granted).')
  }
  return {
    accessToken,
    refreshToken,
    expiresIn: typeof body?.expires_in === 'number' ? body.expires_in : 3600,
    scope: typeof body?.scope === 'string' ? body.scope : null,
  }
}

/** KV custody value (§7.3): the full credential set under the stable user id. */
export function toVocSession(tokens: VocTokenResponse, nowSeconds: number): VocTokenSession {
  return {
    refresh_token: tokens.refreshToken,
    access_token: tokens.accessToken,
    expires_at: nowSeconds + tokens.expiresIn,
    scope: tokens.scope,
  }
}

/**
 * `sub` + `email` from the Supabase JWT payload. No signature check needed —
 * the token arrived directly from Voc over TLS, in exchange for our code.
 */
export function decodeVocIdentity(accessToken: string): VocGrantProps {
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as Record<
      string,
      unknown
    >
    if (typeof payload.sub === 'string' && payload.sub) {
      return {
        voc_user_id: payload.sub,
        voc_email: typeof payload.email === 'string' ? payload.email : null,
      }
    }
  } catch {
    // fall through to the explicit error
  }
  throw new VocAuthError(400, 'The Voc token is not a readable JWT (no sub claim).')
}

/** The second consent hop: the browser goes to Voc's authorize endpoint (§7.2). */
export function buildAuthorizeUrl(
  env: Pick<Env, 'VOC_SUPABASE_URL' | 'VOC_OAUTH_CLIENT_ID' | 'VOC_REDIRECT_URI'>,
  codeChallenge: string,
  state: string,
): string {
  const query = new URLSearchParams({
    client_id: env.VOC_OAUTH_CLIENT_ID,
    redirect_uri: env.VOC_REDIRECT_URI,
    response_type: 'code',
    scope: VOC_SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  return `${env.VOC_SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/oauth/authorize?${query.toString()}`
}

// ---------------------------------------------------------------------------
// Shared small helpers.
// ---------------------------------------------------------------------------

async function createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const codeVerifier = base64UrlEncode(bytes)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  return { codeVerifier, codeChallenge: base64UrlEncode(new Uint8Array(digest)) }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function redirectResponse(location: string, headers: Headers): Response {
  headers.set('Location', location)
  return new Response(null, { status: 302, headers })
}

function copySetCookies(target: Headers, source: Headers): void {
  for (const cookie of source.getSetCookie()) target.append('Set-Cookie', cookie)
}

function errorResponse(status: number, title: string, message: string): Response {
  return new Response(renderErrorPage(title, message), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
