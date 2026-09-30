// Task 6: Voc token refresh and 401 recovery (tech-design §7.3, §9, §11).
//
// The refresh/expiry preflight lives in the `/mcp` api handler
// (`createVocApiHandler`), *before* the MCP handler dispatch: a request whose
// Voc credential is expired, revoked, or absent must become a `401` +
// `WWW-Authenticate` challenge so the client re-authenticates — never an
// `isError` result (which a tool would produce) and certainly never an empty
// tool result that reads as "the user has no records".
//
// These tests drive `vocApiHandler.fetch` directly with a fake `ctx.props` and
// a KV-seeded session, injecting the Supabase stub at the fetch seam so nothing
// touches the network.

import { createExecutionContext, env as poolEnv, reset } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { RESOURCE, createVocApiHandler } from '../src/provider'
import { getVocSession, putVocSession, type VocTokenSession } from '../src/auth/token-store'
import type { Env } from '../src/types/env'
import { errorResponse, jsonResponse } from './helpers'

const env = poolEnv as unknown as Env

const USER_ID = '11111111-1111-4111-8111-111111111111'
const NOW = Math.floor(Date.now() / 1000)

function ctxWithIdentity(vocUserId: string | undefined): ExecutionContext {
  const ctx = createExecutionContext() as ExecutionContext & { props?: Record<string, unknown> }
  if (vocUserId !== undefined) ctx.props = { voc_user_id: vocUserId }
  return ctx
}

/** Supabase stub at the refresh seam — records calls, answers offline (§11). */
function tokenStub(respond: () => Response) {
  const calls: { url: string; method: string; body: string }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    calls.push({ url: request.url, method: request.method, body: await request.text() })
    return respond()
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

async function seedSession(session: VocTokenSession): Promise<void> {
  await putVocSession(env.VOC_SESSIONS, USER_ID, session)
}

/** POST a JSON-RPC message straight at the api handler. */
function mcpCall(handler: { fetch: (r: Request, e: Env, c: ExecutionContext) => Promise<Response> }, body: unknown) {
  return handler.fetch(
    new Request(`${RESOURCE}/mcp`, {
      method: 'POST',
      headers: {
        // The MCP handler enforces a Host allowlist (§10); a pooled Request
        // carries no Host header.
        Host: new URL(RESOURCE).host,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    }),
    env,
    ctxWithIdentity(USER_ID),
  )
}

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
const LIST_TAGS = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_tags', arguments: {} } }

beforeEach(async () => {
  await reset() // wipe OAUTH_KV + VOC_SESSIONS between tests
})

describe('read the Voc access token per request', () => {
  it('passes a still-valid token through without refreshing', async () => {
    await seedSession({
      refresh_token: 'refresh-still-good',
      access_token: 'access-still-good',
      expires_at: NOW + 3600,
      scope: 'offline_access',
    })
    const stub = tokenStub(() => jsonResponse({}))
    const handler = createVocApiHandler({ fetchImpl: stub.fetchImpl })

    const res = await mcpCall(handler, TOOLS_LIST)
    expect(res.status).toBe(200)
    expect(stub.calls).toHaveLength(0) // no refresh, no PostgREST call
  })
})

describe('refresh-on-expiry', () => {
  it('refreshes when the token expires within 60s and persists the rotated pair', async () => {
    // Expired 10s ago — inside (in fact past) the 60s skew window.
    await seedSession({
      refresh_token: 'old-refresh',
      access_token: 'old-access',
      expires_at: NOW - 10,
      scope: 'offline_access',
    })
    const stub = tokenStub(() =>
      jsonResponse({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        scope: 'offline_access',
      }),
    )
    const handler = createVocApiHandler({ fetchImpl: stub.fetchImpl })

    const res = await mcpCall(handler, TOOLS_LIST)
    expect(res.status).toBe(200)

    // The refresh hit the right endpoint with grant_type=refresh_token.
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0].url).toContain('/auth/v1/oauth/token')
    expect(stub.calls[0].method).toBe('POST')
    expect(stub.calls[0].body).toContain('grant_type=refresh_token')
    expect(stub.calls[0].body).toContain('refresh_token=old-refresh')

    // The rotated pair is written back to VOC_SESSIONS.
    const stored = await getVocSession(env.VOC_SESSIONS, USER_ID)
    expect(stored?.access_token).toBe('new-access')
    expect(stored?.refresh_token).toBe('new-refresh')
    expect(stored!.expires_at).toBeGreaterThan(NOW)
  })
})

describe('refresh failure resolves by re-authentication', () => {
  it('returns 401 + WWW-Authenticate and clears KV when Voc rejects the refresh', async () => {
    await seedSession({
      refresh_token: 'revoked-refresh',
      access_token: 'stale-access',
      expires_at: NOW - 10,
      scope: 'offline_access',
    })
    const stub = tokenStub(() =>
      errorResponse(400, { error: 'invalid_grant', error_description: 'refresh token revoked' }),
    )
    const handler = createVocApiHandler({ fetchImpl: stub.fetchImpl })

    const res = await mcpCall(handler, TOOLS_LIST)
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer')
    expect(res.headers.get('WWW-Authenticate')).toContain('oauth-protected-resource')

    // The dead credential is deleted so the next attempt starts from consent.
    expect(await getVocSession(env.VOC_SESSIONS, USER_ID)).toBeNull()
  })

  it('surfaces revocation on a data tool as re-auth, never as []', async () => {
    await seedSession({
      refresh_token: 'revoked-refresh',
      access_token: 'stale-access',
      expires_at: NOW - 10,
      scope: 'offline_access',
    })
    const stub = tokenStub(() => errorResponse(401, { error: 'invalid_grant' }))
    const handler = createVocApiHandler({ fetchImpl: stub.fetchImpl })

    // list_tags would otherwise answer `[]` ("no tags") — it must never run.
    const res = await mcpCall(handler, LIST_TAGS)
    expect(res.status).toBe(401)
    const text = await res.text()
    expect(text).not.toContain('"result"')
    expect(await getVocSession(env.VOC_SESSIONS, USER_ID)).toBeNull()
  })
})
