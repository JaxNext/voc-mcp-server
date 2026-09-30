// Task 4: the Worker as an OAuth client of Voc (tech-design §7).
//
// Drives the REAL OAuthProvider assembly against the REAL (simulated) KV
// bindings, with Supabase stubbed at the handler's fetch seam — no network:
//
//   authorize → consent (CSRF) → 302 to Supabase (offline_access + PKCE)
//   → /callback → code exchange → VOC_SESSIONS custody → grant props
//   → POST /token → decrypted props (identity only, no refresh token)

import {
  getOAuthApi,
  OAuthProvider,
  type OAuthProviderOptions,
} from '@cloudflare/workers-oauth-provider'
import { createExecutionContext, env as poolEnv, reset } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createVocAuthHandler,
  toVocSession,
  type VocTokenResponse,
} from '../src/auth/handler'
import { deleteVocSession, getVocSession, putVocSession } from '../src/auth/token-store'
import type { Env } from '../src/types/env'
import { jsonResponse } from './helpers'

const WORKER_ORIGIN = 'https://worker.test'
const CLIENT_REDIRECT = 'http://localhost:8787/test-client-callback'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const VOC_EMAIL = 'user@example.com'

const JWT = makeJwt({ sub: USER_ID, email: VOC_EMAIL })
const TOKEN_RESPONSE = {
  access_token: JWT,
  refresh_token: 'voc-refresh-token',
  token_type: 'bearer',
  expires_in: 3600,
  scope: 'offline_access',
}

/** Unsigned JWT stand-in — decodeVocIdentity reads the payload, no verify. */
function makeJwt(payload: object): string {
  const part = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signature`
}

interface SupabaseCall {
  url: string
  method: string
  body: string
}

/** Supabase stub at the handler's fetch seam; records every call. */
function makeSupabaseStub(respond: () => Response) {
  const calls: SupabaseCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    calls.push({ url: request.url, method: request.method, body: await request.text() })
    return respond()
  }
  return { calls, fetchImpl }
}

// The pool's env carries the wrangler.jsonc bindings (OAUTH_KV, VOC_SESSIONS,
// vars) as simulated/live objects.
const env = poolEnv as unknown as Env

// The provider's own RFC 9728 resource identifier; the origin the test drives.
const RESOURCE = 'https://worker.test'

interface Setup {
  calls: SupabaseCall[]
  api: ReturnType<typeof getOAuthApi<Env>>
  client: { clientId: string }
  fetchWorker: (request: Request) => Promise<Response>
}

async function setup(respond: () => Response): Promise<Setup> {
  const stub = makeSupabaseStub(respond)
  const options: OAuthProviderOptions<Env> = {
    defaultHandler: createVocAuthHandler({ fetchImpl: stub.fetchImpl }),
    // The provider constructor demands an API route; Task 4 only exercises the
    // defaultHandler (authorize/consent/callback), so this is an inert stub.
    apiRoute: '/mcp',
    apiHandler: { fetch: async () => new Response('ok') },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    accessTokenTTL: 60 * 60 * 24 * 30,
    resourceMetadata: { resource: RESOURCE, resource_name: 'voc-mcp-server' },
  }
  const provider = new OAuthProvider(options)
  const api = getOAuthApi(options, env)
  const client = await api.createClient({
    redirectUris: [CLIENT_REDIRECT],
    clientName: 'E2E Test MCP Client',
    // MCP clients are public (PKCE, no shared secret) — mirrors the DCR path.
    tokenEndpointAuthMethod: 'none',
  })
  const ctx = createExecutionContext()
  return {
    calls: stub.calls,
    api,
    client,
    fetchWorker: (request: Request) => provider.fetch(request, env, ctx),
  }
}

beforeEach(async () => {
  await reset() // wipe OAUTH_KV + VOC_SESSIONS between tests
})

function attr(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html)
  if (!match) throw new Error(`no ${name} field in consent page:\n${html}`)
  return match[1]
}

function cookieHeaderFrom(setCookies: string[]): string {
  return setCookies.map(cookie => cookie.split(';')[0]).join('; ')
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The MCP client's /authorize request; public clients must send PKCE (§3). */
async function authorizeUrlFor(clientId: string, verifier = 'a'.repeat(64)): Promise<URL> {
  const url = new URL(`${WORKER_ORIGIN}/authorize`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', CLIENT_REDIRECT)
  url.searchParams.set('state', 'client-state-123')
  url.searchParams.set('code_challenge', await s256(verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  return url
}

/** Walks authorize → consent-approve; returns the 302 to Supabase. */
async function approveConsent(setup_: Setup, clientId: string) {
  const consentPage = await setup_.fetchWorker(new Request(await authorizeUrlFor(clientId)))
  expect(consentPage.status).toBe(200)
  const html = await consentPage.text()
  const handle = attr(html, 'handle')
  const csrf = attr(html, 'csrf')

  const consentRes = await setup_.fetchWorker(
    new Request(`${WORKER_ORIGIN}/authorize/consent`, {
      method: 'POST',
      body: new URLSearchParams({ handle, csrf, decision: 'approve' }),
      headers: { Cookie: cookieHeaderFrom(consentPage.headers.getSetCookie()) },
    }),
  )
  return { consentPage, html, consentRes }
}

describe('full PKCE browser walkthrough (authorize → consent → Voc → grant)', () => {
  it('lands the Voc session in VOC_SESSIONS and issues props without the refresh token', async () => {
    const s = await setup(() => jsonResponse(TOKEN_RESPONSE))

    // 1. MCP client sends the user to /authorize; consent page renders the client.
    const { consentRes, html } = await approveConsent(s, s.client.clientId)
    expect(html).toContain('E2E Test MCP Client')

    // 2. Approve → 302 to Supabase's authorize endpoint with offline_access + PKCE.
    expect(consentRes.status).toBe(302)
    const supabaseTarget = new URL(consentRes.headers.get('Location')!)
    expect(supabaseTarget.origin).toBe(new URL(env.VOC_SUPABASE_URL).origin)
    expect(supabaseTarget.pathname).toBe('/auth/v1/oauth/authorize')
    expect(supabaseTarget.searchParams.get('client_id')).toBe(env.VOC_OAUTH_CLIENT_ID)
    expect(supabaseTarget.searchParams.get('redirect_uri')).toBe(env.VOC_REDIRECT_URI)
    expect(supabaseTarget.searchParams.get('response_type')).toBe('code')
    expect(supabaseTarget.searchParams.get('scope')).toBe('offline_access')
    expect(supabaseTarget.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(supabaseTarget.searchParams.get('code_challenge_method')).toBe('S256')
    const upstreamState = supabaseTarget.searchParams.get('state')!
    expect(upstreamState).toBeTruthy()

    // 3. Voc signs the user in / consents, then redirects the browser back.
    const callbackRes = await s.fetchWorker(
      new Request(`${WORKER_ORIGIN}/callback?code=voc-auth-code&state=${upstreamState}`, {
        headers: { Cookie: cookieHeaderFrom(consentRes.headers.getSetCookie()) },
      }),
    )
    expect(callbackRes.status).toBe(302)
    const clientTarget = new URL(callbackRes.headers.get('Location')!)
    expect(clientTarget.origin + clientTarget.pathname).toBe(CLIENT_REDIRECT)
    expect(clientTarget.searchParams.get('state')).toBe('client-state-123')
    const workerCode = clientTarget.searchParams.get('code')!
    expect(workerCode).toBeTruthy()

    // 4. Credential set in KV custody, keyed by voc_user_id (§7.3).
    const session = await env.VOC_SESSIONS.get<{
      refresh_token: string
      access_token: string
      expires_at: number
      scope: string
    }>(USER_ID, 'json')
    expect(session).toEqual({
      refresh_token: 'voc-refresh-token',
      access_token: JWT,
      expires_at: expect.any(Number),
      scope: 'offline_access',
    })
    expect(Math.abs(session!.expires_at - (Date.now() / 1000 + 3600))).toBeLessThan(60)

    // 5. The exchange sent the stored verifier, the registered redirect URI and
    //    no client secret (public client, auth method "none").
    const exchange = s.calls.find(call => call.url.endsWith('/auth/v1/oauth/token'))
    expect(exchange).toBeTruthy()
    expect(exchange!.method).toBe('POST')
    const form = new URLSearchParams(exchange!.body)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('voc-auth-code')
    expect(form.get('client_id')).toBe(env.VOC_OAUTH_CLIENT_ID)
    expect(form.get('redirect_uri')).toBe(env.VOC_REDIRECT_URI)
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(form.get('client_secret')).toBeNull()

    // 6. The MCP client redeems the Worker's code at /token.
    const tokenRes = await s.fetchWorker(
      new Request(`${WORKER_ORIGIN}/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: workerCode,
          redirect_uri: CLIENT_REDIRECT,
          client_id: s.client.clientId,
          code_verifier: 'a'.repeat(64),
        }),
      }),
    )
    expect(tokenRes.status).toBe(200)
    const tokenBody = (await tokenRes.json()) as { access_token: string }

    // 7. Decrypted props carry identity only — never the refresh token (§7.3).
    const summary = await s.api.unwrapToken<{ voc_user_id: string; voc_email: string }>(
      tokenBody.access_token,
    )
    expect(summary).not.toBeNull()
    expect(summary!.grant.props).toEqual({ voc_user_id: USER_ID, voc_email: VOC_EMAIL })
    expect(Object.keys(summary!.grant.props).sort()).toEqual(['voc_email', 'voc_user_id'])
    expect(JSON.stringify(summary)).not.toContain('voc-refresh-token')
  })
})

describe('consent screen defenses', () => {
  it('rejects a consent POST whose csrf field does not match the cookie', async () => {
    const s = await setup(() => jsonResponse(TOKEN_RESPONSE))
    const consentPage = await s.fetchWorker(new Request(await authorizeUrlFor(s.client.clientId)))
    const html = await consentPage.text()
    const handle = attr(html, 'handle')

    const res = await s.fetchWorker(
      new Request(`${WORKER_ORIGIN}/authorize/consent`, {
        method: 'POST',
        body: new URLSearchParams({ handle, csrf: 'forged-token', decision: 'approve' }),
        headers: { Cookie: cookieHeaderFrom(consentPage.headers.getSetCookie()) },
      }),
    )
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('CSRF check failed')
  })

  it('redirects a deny decision back to the client with access_denied and the state', async () => {
    const s = await setup(() => jsonResponse(TOKEN_RESPONSE))
    const consentPage = await s.fetchWorker(new Request(await authorizeUrlFor(s.client.clientId)))
    const html = await consentPage.text()
    const res = await s.fetchWorker(
      new Request(`${WORKER_ORIGIN}/authorize/consent`, {
        method: 'POST',
        body: new URLSearchParams({
          handle: attr(html, 'handle'),
          csrf: attr(html, 'csrf'),
          decision: 'deny',
        }),
        headers: { Cookie: cookieHeaderFrom(consentPage.headers.getSetCookie()) },
      }),
    )
    expect(res.status).toBe(302)
    const target = new URL(res.headers.get('Location')!)
    expect(target.origin + target.pathname).toBe(CLIENT_REDIRECT)
    expect(target.searchParams.get('error')).toBe('access_denied')
    expect(target.searchParams.get('state')).toBe('client-state-123')
    // Nothing was stored.
    expect(await env.VOC_SESSIONS.get(USER_ID)).toBeNull()
  })
})

describe('callback failure modes', () => {
  it('rejects a callback with an unknown state instead of creating a grant', async () => {
    const s = await setup(() => jsonResponse(TOKEN_RESPONSE))
    const res = await s.fetchWorker(new Request(`${WORKER_ORIGIN}/callback?code=x&state=forged`))
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/expired or replayed/i)
    expect(await env.VOC_SESSIONS.get(USER_ID)).toBeNull()
  })

  it('renders a recovery page when Voc rejects the code exchange — never empty success', async () => {
    const s = await setup(() =>
      jsonResponse({ error: 'invalid_grant', error_description: 'code already used' }, 400),
    )
    const { consentRes } = await approveConsent(s, s.client.clientId)
    const upstreamState = new URL(consentRes.headers.get('Location')!).searchParams.get('state')!

    const res = await s.fetchWorker(
      new Request(`${WORKER_ORIGIN}/callback?code=voc-auth-code&state=${upstreamState}`, {
        headers: { Cookie: cookieHeaderFrom(consentRes.headers.getSetCookie()) },
      }),
    )
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain('Voc sign-in failed')
    expect(text).toContain('code already used')
    expect(text).toContain('Restart the connection')
    expect(await env.VOC_SESSIONS.get(USER_ID)).toBeNull()
  })
})

describe('token-store', () => {
  it('round-trips and deletes the credential set keyed by voc_user_id', async () => {
    const kv = env.VOC_SESSIONS
    expect(await getVocSession(kv, USER_ID)).toBeNull()

    const session = toVocSession(
      { accessToken: 'at', refreshToken: 'rt', expiresIn: 60, scope: 'offline_access' },
      1000,
    )
    expect(session).toEqual({
      refresh_token: 'rt',
      access_token: 'at',
      expires_at: 1060,
      scope: 'offline_access',
    })

    await putVocSession(kv, USER_ID, session)
    expect(await getVocSession(kv, USER_ID)).toEqual(session)
    await deleteVocSession(kv, USER_ID)
    expect(await getVocSession(kv, USER_ID)).toBeNull()
  })
})

describe('token response edge cases', () => {
  it('refuses a token response without a refresh token — offline_access is required (§7.3)', async () => {
    const s = await setup(() => jsonResponse({ access_token: JWT, token_type: 'bearer', expires_in: 3600 }))
    const { consentRes } = await approveConsent(s, s.client.clientId)
    const upstreamState = new URL(consentRes.headers.get('Location')!).searchParams.get('state')!

    const res = await s.fetchWorker(
      new Request(`${WORKER_ORIGIN}/callback?code=voc-auth-code&state=${upstreamState}`, {
        headers: { Cookie: cookieHeaderFrom(consentRes.headers.getSetCookie()) },
      }),
    )
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('no refresh token')
    expect(await env.VOC_SESSIONS.get(USER_ID)).toBeNull()
  })

  it('builds the custody value from the raw token response', () => {
    const tokens: VocTokenResponse = {
      accessToken: 'a.b.c',
      refreshToken: 'r',
      expiresIn: 3600,
      scope: 'offline_access',
    }
    expect(toVocSession(tokens, 100)).toEqual({
      refresh_token: 'r',
      access_token: 'a.b.c',
      expires_at: 3700,
      scope: 'offline_access',
    })
  })
})
