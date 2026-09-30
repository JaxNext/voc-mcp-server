// Voc token refresh and expiry (tech-design §7.3).
//
// The credential set in VOC_SESSIONS has a short-lived access token (Supabase
// issues ~1h) plus a long-lived, **rotating** refresh token. This module is the
// only place that reads that set for a request: it hands back a usable access
// token, refreshing through `POST /auth/v1/oauth/token` when the token is about
// to expire and persisting the rotated pair back to KV.
//
// Failure is never silent: a refresh that cannot succeed means the user must
// re-authenticate. `VocSessionExpiredError` is how that surfaces — the caller
// (the `/mcp` api handler) turns it into a `401` + `WWW-Authenticate` challenge
// so the MCP client re-runs the full flow. Degrading to empty results would make
// an assistant believe the user has no records (§7.3, §9).

import {
  deleteVocSession,
  getVocSession,
  putVocSession,
  type VocTokenSession,
} from './token-store'

/**
 * Refresh when the access token expires within this window (§7.3) — a request
 * that starts just before expiry must not fail mid-flight against PostgREST.
 */
export const REFRESH_SKEW_SECONDS = 60

/** The Voc credential is unusable and the user must re-authenticate. */
export class VocSessionExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VocSessionExpiredError'
  }
}

/** The env surface this module needs — a subset of `Env`. */
export interface RefreshEnv {
  VOC_SESSIONS: KVNamespace
  VOC_SUPABASE_URL: string
  VOC_OAUTH_CLIENT_ID: string
}

/**
 * Return a usable Voc access token for `vocUserId`, refreshing first if it
 * expires within `REFRESH_SKEW_SECONDS`. Throws `VocSessionExpiredError` when
 * there is no stored session or the refresh cannot be completed — in both cases
 * the stored entry is cleared so the next attempt starts from a clean consent.
 */
export async function loadVocSession(
  env: RefreshEnv,
  vocUserId: string,
  nowSeconds: number,
  doFetch: typeof fetch = fetch,
): Promise<VocTokenSession> {
  const session = await getVocSession(env.VOC_SESSIONS, vocUserId)
  if (!session) {
    throw new VocSessionExpiredError('No stored Voc credential for this user. Reconnect the MCP client to Voc.')
  }
  if (session.expires_at - nowSeconds > REFRESH_SKEW_SECONDS) {
    return session
  }

  try {
    const refreshed = await refreshVocSession(env, session, nowSeconds, doFetch)
    await putVocSession(env.VOC_SESSIONS, vocUserId, refreshed)
    return refreshed
  } catch (error) {
    // Revoked / expired / signed out — drop the entry so the client re-runs the
    // full OAuth flow, and surface re-authentication instead of empty data.
    await deleteVocSession(env.VOC_SESSIONS, vocUserId)
    throw error instanceof VocSessionExpiredError
      ? error
      : new VocSessionExpiredError(`Voc session refresh failed: ${describe(error)}`)
  }
}

/**
 * Exchange the refresh token at `POST /auth/v1/oauth/token` (§7.3). Public
 * client: `client_id` + `refresh_token`, no secret (auth method "none").
 * Supabase rotates the refresh token — the response carries a new one; keep the
 * old value only if Voc omits it.
 */
export async function refreshVocSession(
  env: RefreshEnv,
  session: VocTokenSession,
  nowSeconds: number,
  doFetch: typeof fetch = fetch,
): Promise<VocTokenSession> {
  let res: Response
  try {
    res = await doFetch(`${env.VOC_SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refresh_token,
        client_id: env.VOC_OAUTH_CLIENT_ID,
        auth_method: 'none',
      }).toString(),
    })
  } catch (error) {
    throw new VocSessionExpiredError(`Could not reach Voc to refresh the session (${describe(error)}).`)
  }

  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const detail =
      typeof body?.error_description === 'string'
        ? body.error_description
        : typeof body?.error === 'string'
          ? body.error
          : typeof body?.message === 'string'
            ? body.message
            : `HTTP ${res.status}`
    throw new VocSessionExpiredError(`Voc rejected the session refresh: ${detail}.`)
  }

  const accessToken = body?.access_token
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new VocSessionExpiredError('Voc sent no access token on refresh.')
  }
  return {
    refresh_token:
      typeof body?.refresh_token === 'string' && body.refresh_token
        ? body.refresh_token
        : session.refresh_token,
    access_token: accessToken,
    expires_at: nowSeconds + (typeof body?.expires_in === 'number' ? body.expires_in : 3600),
    scope: typeof body?.scope === 'string' ? body.scope : session.scope,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
