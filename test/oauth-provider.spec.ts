// Task 5: the OAuthProvider around /mcp (tech-design §7.1, §7.2, §8, §10).
//
// Two layers are exercised:
//   1. The Worker's real default export — discovery metadata, DCR, and the
//      bearer-token gate on /mcp — driven straight through `worker.fetch`.
//   2. A full end-to-end run (discovery → DCR → authorize → consent → Voc
//      callback → /token → tools/list) built from the same `vocApiHandler`
//      plus a Supabase-stubbed Voc auth handler, proving identity flows props →
//      KV → the MCP tool surface on the v2 stateless path.

import { OAuthProvider, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider'
import { createExecutionContext, env as poolEnv, reset } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/index'
import { vocApiHandler } from '../src/provider'
import { createVocAuthHandler } from '../src/auth/handler'
import type { Env } from '../src/types/env'
import { jsonResponse } from './helpers'

const env = poolEnv as unknown as Env
const ctx = createExecutionContext()

const USER_ID = '11111111-1111-4111-8111-111111111111'
const VOC_EMAIL = 'user@example.com'
// The request origin the tests drive the Worker with. The Worker derives its
// RFC 9728 `resource` (and its WWW-Authenticate metadata URL) from the request
// origin, so this must match the URLs below.
const RESOURCE = 'http://localhost:8787'
const CLIENT_REDIRECT = 'http://localhost:8787/test-client-callback'
const JWT = makeJwt({ sub: USER_ID, email: VOC_EMAIL })
const TOKEN_RESPONSE = {
  access_token: JWT,
  refresh_token: 'voc-refresh-token',
  token_type: 'bearer',
  expires_in: 3600,
  scope: 'offline_access',
}

const SIX_TOOLS = [
  'create_record',
  'delete_record',
  'get_record',
  'list_tags',
  'search_records',
  'update_record',
]

/** Unsigned JWT stand-in — decodeVocIdentity reads the payload, no verify. */
function makeJwt(payload: object): string {
  const part = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signature`
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

function cookieHeaderFrom(setCookies: string[]): string {
  return setCookies.map(cookie => cookie.split(';')[0]).join('; ')
}

function attr(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html)
  if (!match) throw new Error(`no ${name} field in consent page:\n${html}`)
  return match[1]
}

/** Supabase stub at the Voc handler's fetch seam — records calls, no network. */
function makeSupabaseStub(respond: () => Response) {
  const calls: { url: string; method: string; body: string }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    calls.push({ url: request.url, method: request.method, body: await request.text() })
    return respond()
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

/** POST a JSON-RPC message to /mcp; tolerates a JSON or SSE reply. */
async function callMcp(url: string, token: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    // The MCP handler enforces a Host allowlist (§10); a pooled Request carries
    // no Host header, so the test supplies the dev hostname explicitly.
    Host: new URL(url).host,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return worker.fetch(
    new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }),
    env,
    ctx,
  )
}

/** Parses a JSON or SSE JSON-RPC response body into the first message. */
function parseJsonRpc(text: string): { result?: { tools?: { name: string }[] }; error?: unknown } {
  if (text.startsWith('{')) return JSON.parse(text)
  const dataLine = text.split('\n').find(line => line.startsWith('data:'))
  if (!dataLine) throw new Error(`no JSON-RPC payload in response:\n${text}`)
  return JSON.parse(dataLine.slice('data:'.length).trim())
}

beforeEach(async () => {
  await reset() // wipe OAUTH_KV + VOC_SESSIONS between tests
})

describe('discovery metadata (RFC 8414 + RFC 9728)', () => {
  it('serves well-formed authorization-server metadata', async () => {
    const res = await worker.fetch(
      new Request(`${RESOURCE}/.well-known/oauth-authorization-server`),
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    const meta = (await res.json()) as Record<string, unknown>
    expect(new URL(meta.issuer as string).origin).toBe(RESOURCE)
    expect(meta.authorization_endpoint).toBe(`${RESOURCE}/authorize`)
    expect(meta.token_endpoint).toBe(`${RESOURCE}/token`)
    expect(meta.registration_endpoint).toBe(`${RESOURCE}/register`)
    expect(meta.code_challenge_methods_supported).toContain('S256')
  })

  it('serves well-formed protected-resource metadata pointing back at itself', async () => {
    const res = await worker.fetch(
      new Request(`${RESOURCE}/.well-known/oauth-protected-resource`),
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    const meta = (await res.json()) as Record<string, unknown>
    expect(meta.resource).toBe(RESOURCE)
    expect(meta.authorization_servers).toContain(RESOURCE)
    expect(meta.bearer_methods_supported).toContain('header')
  })
})

describe('dynamic client registration', () => {
  it('returns a usable public client whose client_id can start /authorize', async () => {
    const res = await worker.fetch(
      new Request(`${RESOURCE}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [CLIENT_REDIRECT],
          client_name: 'DCR Test MCP Client',
          token_endpoint_auth_method: 'none',
        }),
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(201)
    const client = (await res.json()) as { client_id: string; redirect_uris: string[] }
    expect(client.client_id).toBeTruthy()
    expect(client.redirect_uris).toEqual([CLIENT_REDIRECT])

    // Usable: the provider resolves the client and renders the consent page.
    const authorize = new URL(`${RESOURCE}/authorize`)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('client_id', client.client_id)
    authorize.searchParams.set('redirect_uri', CLIENT_REDIRECT)
    authorize.searchParams.set('state', 'client-state-123')
    authorize.searchParams.set('code_challenge', await s256('a'.repeat(64)))
    authorize.searchParams.set('code_challenge_method', 'S256')
    const consent = await worker.fetch(new Request(authorize), env, ctx)
    expect(consent.status).toBe(200)
    expect(await consent.text()).toContain('DCR Test MCP Client')
  })
})

describe('/mcp bearer-token gate', () => {
  const toolsList = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }

  it('rejects a request with no Authorization header, with a Bearer challenge', async () => {
    const res = await callMcp(`${RESOURCE}/mcp`, null, toolsList)
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer')
  })

  it('rejects an opaque token that is not a Worker-issued credential', async () => {
    const res = await callMcp(`${RESOURCE}/mcp`, 'not-a-real-token', toolsList)
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer')
  })

  it('rejects a well-formed but foreign three-part token', async () => {
    const res = await callMcp(`${RESOURCE}/mcp`, 'user:grant:secret', toolsList)
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer')
  })
})

describe('end-to-end: discovery → DCR → authorize → token → tool call', () => {
  it('authenticates /mcp with a real grant and lists the six tools (v2 stateless)', async () => {
    const stub = makeSupabaseStub(() => jsonResponse(TOKEN_RESPONSE))
    const options: OAuthProviderOptions<Env> = {
      apiRoute: '/mcp',
      apiHandler: vocApiHandler,
      defaultHandler: createVocAuthHandler({ fetchImpl: stub.fetchImpl }),
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      accessTokenTTL: 60 * 60 * 24 * 30,
      resourceMetadata: { resource: RESOURCE, resource_name: 'voc-mcp-server' },
    }
    const provider = new OAuthProvider(options)
    const fetchWorker = (request: Request) => provider.fetch(request, env, ctx)

    // 1. DCR — the MCP client registers itself.
    const registration = await fetchWorker(
      new Request(`${RESOURCE}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [CLIENT_REDIRECT],
          client_name: 'E2E MCP Client',
          token_endpoint_auth_method: 'none',
        }),
      }),
    )
    expect(registration.status).toBe(201)
    const clientId = ((await registration.json()) as { client_id: string }).client_id

    // 2. /authorize → consent page.
    const verifier = 'a'.repeat(64)
    const authorize = new URL(`${RESOURCE}/authorize`)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('client_id', clientId)
    authorize.searchParams.set('redirect_uri', CLIENT_REDIRECT)
    authorize.searchParams.set('state', 'client-state-123')
    authorize.searchParams.set('code_challenge', await s256(verifier))
    authorize.searchParams.set('code_challenge_method', 'S256')
    const consentPage = await fetchWorker(new Request(authorize))
    expect(consentPage.status).toBe(200)
    const html = await consentPage.text()

    // 3. Approve → 302 to Supabase (the second consent hop, §7.2).
    const consentRes = await fetchWorker(
      new Request(`${RESOURCE}/authorize/consent`, {
        method: 'POST',
        body: new URLSearchParams({
          handle: attr(html, 'handle'),
          csrf: attr(html, 'csrf'),
          decision: 'approve',
        }),
        headers: { Cookie: cookieHeaderFrom(consentPage.headers.getSetCookie()) },
      }),
    )
    expect(consentRes.status).toBe(302)
    const upstreamState = new URL(consentRes.headers.get('Location')!).searchParams.get('state')!

    // 4. Voc redirects back to /callback → code exchange → KV custody → grant.
    const callbackRes = await fetchWorker(
      new Request(`${RESOURCE}/callback?code=voc-auth-code&state=${upstreamState}`, {
        headers: { Cookie: cookieHeaderFrom(consentRes.headers.getSetCookie()) },
      }),
    )
    expect(callbackRes.status).toBe(302)
    const workerCode = new URL(callbackRes.headers.get('Location')!).searchParams.get('code')!
    expect(workerCode).toBeTruthy()

    // 5. The MCP client redeems the Worker code at /token.
    const tokenRes = await fetchWorker(
      new Request(`${RESOURCE}/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: workerCode,
          redirect_uri: CLIENT_REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        }),
      }),
    )
    expect(tokenRes.status).toBe(200)
    const accessToken = ((await tokenRes.json()) as { access_token: string }).access_token
    expect(accessToken).toBeTruthy()

    // 6. /mcp accepts the real token and the MCP handler answers tools/list.
    const mcpRes = await worker.fetch(
      new Request(`${RESOURCE}/mcp`, {
        method: 'POST',
        headers: {
          Host: new URL(RESOURCE).host,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      env,
      ctx,
    )
    expect(mcpRes.status).toBe(200)
    // v2 stateless: no session handshake, no Mcp-Session-Id (§3.1).
    expect(mcpRes.headers.get('Mcp-Session-Id')).toBeNull()
    const payload = parseJsonRpc(await mcpRes.text())
    expect(payload.error).toBeUndefined()
    expect(payload.result?.tools?.map(tool => tool.name).sort()).toEqual(SIX_TOOLS)
  })
})
