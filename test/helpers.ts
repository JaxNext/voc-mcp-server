// Shared test helpers: an offline PostgREST stub. Tests inject it as the
// client's fetch implementation — no network, no real Supabase (§11).

import { PostgrestClient } from '../src/voc/postgrest'

export interface CapturedRequest {
  method: string
  url: URL
  headers: Record<string, string>
  body: unknown
}

export type RouteHandler = (req: CapturedRequest) => Response | Promise<Response>

export interface StubClient {
  client: PostgrestClient
  /** Every request the client made, in order. */
  requests: CapturedRequest[]
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === null || body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export function errorResponse(status: number, body: Record<string, unknown>): Response {
  return jsonResponse(body, status)
}

/**
 * Build a client whose requests are answered by `handler`. Routes match on
 * `method + pathname`, e.g. `POST /rest/v1/records`.
 */
export function stubClient(handler: RouteHandler): StubClient {
  const requests: CapturedRequest[] = []

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    const text = await req.text()
    const captured: CapturedRequest = {
      method: req.method,
      url: new URL(req.url),
      headers: Object.fromEntries(req.headers.entries()),
      body: text ? JSON.parse(text) : undefined,
    }
    requests.push(captured)
    return handler(captured)
  }) as unknown as typeof fetch

  const client = new PostgrestClient({
    baseUrl: 'https://voc-project.supabase.co',
    anonKey: 'test-anon-key',
    token: 'test-user-jwt',
    fetchImpl,
  })

  return { client, requests }
}

/** `/rest/v1/records` → `records`. */
export function tableOf(req: CapturedRequest): string {
  return req.url.pathname.replace('/rest/v1/', '')
}
