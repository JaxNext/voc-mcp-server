import { describe, expect, it } from 'vitest'
import { searchRecords } from '../src/voc/records'
import { jsonResponse, stubClient, tableOf, type CapturedRequest } from './helpers'

const RECORD_ID = '22222222-2222-2222-2222-222222222222'
const TAG_1 = '33333333-3333-3333-3333-333333333333'
const TAG_2 = '44444444-4444-4444-4444-444444444444'

// Records select handler: asserts shape via captured requests, returns rows.
function recordsHandler(rows: unknown[], contentRange: string) {
  return (req: CapturedRequest) => {
    if (req.method === 'GET' && tableOf(req) === 'records') {
      return jsonResponse(rows, 200, { 'content-range': contentRange })
    }
    throw new Error(`unexpected request: ${req.method} ${req.url.pathname}`)
  }
}

describe('searchRecords — search term handling', () => {
  it('strips , ( ) from the term before building the or= filter', async () => {
    const { client, requests } = stubClient(recordsHandler([], '*/0'))

    await searchRecords(client, { search: 'a,b(c)' })

    const or = requests[0].url.searchParams.get('or')
    // Each stripped char becomes one space, exactly like Voc's
    // sanitizeSearchTerm (replace + trim, no whitespace collapsing).
    expect(or).toBe('(content.ilike.*a b c*,meaning.ilike.*a b c*)')
  })

  it('sends no or= filter without a search term', async () => {
    const { client, requests } = stubClient(recordsHandler([], '*/0'))

    await searchRecords(client, {})

    expect(requests[0].url.searchParams.has('or')).toBe(false)
  })

  it('applies the type filter only when not "all"', async () => {
    const { client, requests } = stubClient(recordsHandler([], '*/0'))

    await searchRecords(client, { type: 'word' })
    expect(requests[0].url.searchParams.get('type')).toBe('eq.word')

    await searchRecords(client, { type: 'all' })
    expect(requests[1].url.searchParams.has('type')).toBe(false)
  })
})

describe('searchRecords — tag filtering is a two-step union', () => {
  it('resolves ids from record_tags first, then id=in.(…) — never an !inner join', async () => {
    const { client, requests } = stubClient(req => {
      if (req.method === 'GET' && tableOf(req) === 'record_tags') {
        // A record carrying BOTH tags appears twice — the union dedupes it.
        return jsonResponse([
          { record_id: RECORD_ID },
          { record_id: RECORD_ID },
          { record_id: '99999999-9999-9999-9999-999999999999' },
        ])
      }
      if (req.method === 'GET' && tableOf(req) === 'records') {
        return jsonResponse([], 200, { 'content-range': '*/0' })
      }
      throw new Error(`unexpected request: ${req.method} ${req.url.pathname}`)
    })

    await searchRecords(client, { tagIds: [TAG_1, TAG_2] })

    expect(requests).toHaveLength(2)
    // Step 1 — the union source query.
    expect(tableOf(requests[0])).toBe('record_tags')
    expect(requests[0].url.searchParams.get('tag_id')).toBe(`in.(${TAG_1},${TAG_2})`)
    expect(requests[0].url.searchParams.get('select')).toBe('record_id')
    // Step 2 — deduped ids in `in.()`; the embed stays a left join.
    expect(tableOf(requests[1])).toBe('records')
    expect(requests[1].url.searchParams.get('id')).toBe(
      `in.(${RECORD_ID},99999999-9999-9999-9999-999999999999)`,
    )
    const select = requests[1].url.searchParams.get('select')
    expect(select).toBe('*,record_tags(tags(*))')
    expect(select).not.toContain('!inner')
  })

  it('short-circuits with zero results when the union is empty — one request only', async () => {
    const { client, requests } = stubClient(r => {
      if (r.method === 'GET' && tableOf(r) === 'record_tags') return jsonResponse([])
      throw new Error('records must never be queried when the union is empty')
    })

    const result = await searchRecords(client, { tagIds: [TAG_1] })

    expect(result).toEqual({ records: [], total: 0, hasMore: false, page: 1 })
    expect(requests).toHaveLength(1)
    expect(tableOf(requests[0])).toBe('record_tags')
  })

  it('does not query record_tags when no tag filter is given', async () => {
    const { client, requests } = stubClient(recordsHandler([], '*/0'))

    await searchRecords(client, {})

    expect(requests).toHaveLength(1)
    expect(tableOf(requests[0])).toBe('records')
  })
})

describe('searchRecords — pagination, count and ordering', () => {
  it('requests the exact page and reports total/hasMore from content-range', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `row-${i}`, record_tags: [] }))
    const { client, requests } = stubClient(recordsHandler(rows, '20-29/45'))

    const result = await searchRecords(client, { page: 3, pageSize: 10 })

    const req = requests[0]
    expect(req.url.searchParams.get('limit')).toBe('10')
    expect(req.url.searchParams.get('offset')).toBe('20')
    expect(req.headers.prefer).toBe('count=exact')

    expect(result.page).toBe(3)
    expect(result.total).toBe(45)
    expect(result.records).toHaveLength(10)
    expect(result.hasMore).toBe(true) // 20 + 10 < 45
  })

  it('reports hasMore=false on the last page', async () => {
    const rows = [{ id: 'row-0', record_tags: [] }]
    const { client } = stubClient(recordsHandler(rows, '20-20/21'))

    const result = await searchRecords(client, { page: 3, pageSize: 10 })
    expect(result.hasMore).toBe(false) // 20 + 1 = 21
  })

  it('maps sort variants to order specs with the id tiebreak', async () => {
    const { client, requests } = stubClient(recordsHandler([], '*/0'))

    await searchRecords(client, { sort: 'newest' })
    await searchRecords(client, { sort: 'oldest' })
    await searchRecords(client, { sort: 'alphabetical' })

    expect(requests[0].url.searchParams.get('order')).toBe('created_at.desc,id')
    expect(requests[1].url.searchParams.get('order')).toBe('created_at.asc,id')
    expect(requests[2].url.searchParams.get('order')).toBe('content,id')
  })

  it('flattens the tag embed, dropping RLS-filtered null tags', async () => {
    const rows = [
      {
        id: RECORD_ID,
        type: 'word',
        content: 'commute',
        meaning: 'to travel to work',
        source: null,
        notes: null,
        user_id: 'u',
        created_at: '2026-09-29T00:00:00Z',
        updated_at: '2026-09-29T00:00:00Z',
        record_tags: [{ tags: { id: TAG_1, name: 'travel', is_predefined: true, user_id: null, created_at: '' } }, { tags: null }],
      },
    ]
    const { client } = stubClient(recordsHandler(rows, '0-0/1'))

    const result = await searchRecords(client, {})

    expect(result.records[0].tags).toEqual([
      { id: TAG_1, name: 'travel', is_predefined: true, user_id: null, created_at: '' },
    ])
  })
})
