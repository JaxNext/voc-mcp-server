// Typed PostgREST client for Voc's Supabase surface (tech-design §5.1).
//
// Every request carries `apikey: <anon key>` and
// `Authorization: Bearer <user JWT>`, so RLS scopes every row to the calling
// user exactly as the Voc browser client does. The service-role key is never
// present in this project (§10).
//
// The fetch implementation is injectable so unit tests run offline against a
// stub — no network, no real Supabase dependency (§11).

export interface PostgrestOptions {
  /** Supabase project base URL, e.g. `https://<ref>.supabase.co`. */
  baseUrl: string
  /** Supabase anon (publishable) key — sent as `apikey`. */
  anonKey: string
  /** The calling user's Voc access token — sent as `Authorization: Bearer`. */
  token: string
  /** Injectable for tests; defaults to the Workers global `fetch`. */
  fetchImpl?: typeof fetch
}

/** Error body PostgREST returns for failed requests. */
interface PostgrestErrorBody {
  message?: string
  details?: string | null
  hint?: string | null
  code?: string | null
}

export class PostgrestError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly details: string | undefined
  readonly hint: string | undefined

  constructor(status: number, body: PostgrestErrorBody | null, fallback: string) {
    // Message + details together so no error context is dropped (§9) — the
    // raw response body is never surfaced as-is.
    const message = body?.message
      ? (body.details ? `${body.message} — ${body.details}` : body.message)
      : fallback
    super(message)
    this.name = 'PostgrestError'
    this.status = status
    this.code = body?.code ?? undefined
    this.details = body?.details ?? undefined
    this.hint = body?.hint ?? undefined
  }
}

/** "JSON object requested, multiple (or no) rows returned." */
export const PGRST_NOT_SINGLE = 'PGRST116'

const SINGLE_ACCEPT = 'application/vnd.pgrst.object+json'

export interface SelectParams {
  select?: string
  /** Raw PostgREST filter pairs, e.g. `id=eq.<uuid>`, `tag_id=in.(a,b)`. */
  filters?: string[]
  /** PostgREST order spec, e.g. `created_at.desc,id`. */
  order?: string
  limit?: number
  offset?: number
  /** Ask for an exact total (`Prefer: count=exact` + `content-range`). */
  count?: boolean
}

export interface SelectResult<T> {
  rows: T[]
  /** Exact total when `count` was requested and PostgREST reported one. */
  total: number | null
}

interface RawResponse {
  status: number
  headers: Headers
  body: unknown
}

export class PostgrestClient {
  private readonly base: string
  private readonly anonKey: string
  private readonly token: string
  private readonly doFetch: typeof fetch

  constructor(options: PostgrestOptions) {
    this.base = `${options.baseUrl.replace(/\/+$/, '')}/rest/v1`
    this.anonKey = options.anonKey
    this.token = options.token
    this.doFetch = options.fetchImpl ?? fetch
  }

  /** Multi-row select. An empty result is `rows: []`, never an error. */
  async select<T>(table: string, params: SelectParams = {}): Promise<SelectResult<T>> {
    const res = await this.request(
      table,
      params,
      params.count ? { Prefer: 'count=exact' } : {},
    )
    const rows = (Array.isArray(res.body) ? res.body : []) as T[]
    const total = params.count
      ? parseContentRange(res.headers.get('content-range'))
      : null
    return { rows, total }
  }

  /**
   * Single-row select via the `vnd.pgrst.object` accept header. Zero rows
   * (406 + PGRST116) or a `200 + []` fallback → null, i.e. *not found* —
   * never "the user has no records" (§9).
   */
  async selectMaybeOne<T>(table: string, params: SelectParams = {}): Promise<T | null> {
    return this.maybeOne<T>(this.request(table, params, { Accept: SINGLE_ACCEPT }))
  }

  /** Insert. `single: true` returns the created row; otherwise returns nothing. */
  async insert<T>(table: string, body: unknown, options: { single?: boolean } = {}): Promise<T | null> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (options.single) {
      headers.Prefer = 'return=representation'
      headers.Accept = SINGLE_ACCEPT
    }
    const res = await this.request(table, {}, headers, { method: 'POST', body: JSON.stringify(body) })
    if (!options.single) return null
    return (res.body as T) ?? null
  }

  /**
   * PATCH with representation. Zero affected rows (406 + PGRST116) → null —
   * the id does not exist or is RLS-invisible (§9).
   */
  async update<T>(table: string, filters: string[], body: unknown): Promise<T | null> {
    return this.maybeOne<T>(
      this.request(
        table,
        { filters },
        { 'Content-Type': 'application/json', Prefer: 'return=representation', Accept: SINGLE_ACCEPT },
        { method: 'PATCH', body: JSON.stringify(body) },
      ),
    )
  }

  /** Delete one row and return it (for confirmation messages). PGRST116 → null. */
  async deleteOne<T>(table: string, filters: string[]): Promise<T | null> {
    return this.maybeOne<T>(
      this.request(
        table,
        { filters },
        { Prefer: 'return=representation', Accept: SINGLE_ACCEPT },
        { method: 'DELETE' },
      ),
    )
  }

  /** Bulk delete by filter (tag-diff removal). No representation needed. */
  async deleteWhere(table: string, filters: string[]): Promise<void> {
    await this.request(table, { filters }, {}, { method: 'DELETE' })
  }

  /**
   * Shared zero-row handling: 406 + PGRST116 and `200 + []` both map to null
   * so callers can turn them into an explicit not-found message (§9).
   */
  private async maybeOne<T>(request: Promise<RawResponse>): Promise<T | null> {
    try {
      const res = await request
      if (Array.isArray(res.body)) return (res.body[0] as T | undefined) ?? null
      return (res.body as T) ?? null
    } catch (error) {
      if (error instanceof PostgrestError && error.code === PGRST_NOT_SINGLE) return null
      throw error
    }
  }

  private async request(
    table: string,
    params: SelectParams,
    headers: Record<string, string>,
    init: { method?: string; body?: string } = {},
  ): Promise<RawResponse> {
    const query = buildQuery(params)
    const path = query ? `${table}?${query}` : table
    const res = await this.doFetch(`${this.base}/${path}`, {
      method: init.method ?? 'GET',
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.token}`,
        ...headers,
      },
      body: init.body,
    })
    const text = await res.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = null // non-JSON body (e.g. gateway error) — mapped below
      }
    }
    if (!res.ok) {
      // Surface status + PostgREST message/details — never a raw dump (§9).
      const errorBody = body !== null && typeof body === 'object' ? (body as PostgrestErrorBody) : null
      throw new PostgrestError(res.status, errorBody, `PostgREST request failed with status ${res.status}`)
    }
    return { status: res.status, headers: res.headers, body }
  }
}

function buildQuery(params: SelectParams): string {
  const query = new URLSearchParams()
  if (params.select) query.set('select', params.select)
  for (const filter of params.filters ?? []) {
    const eq = filter.indexOf('=')
    if (eq > 0) query.set(filter.slice(0, eq), filter.slice(eq + 1))
  }
  if (params.order) query.set('order', params.order)
  if (params.limit !== undefined) query.set('limit', String(params.limit))
  if (params.offset !== undefined) query.set('offset', String(params.offset))
  return query.toString()
}

/** `content-range: 0-19/42` → 42; a star total → null; missing → null. */
function parseContentRange(header: string | null): number | null {
  if (!header) return null
  const total = header.split('/')[1]
  return total && total !== '*' ? Number(total) : null
}
