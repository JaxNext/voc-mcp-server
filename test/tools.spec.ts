// End-to-end-ish tool tests over InMemoryTransport: the same path MCP
// Inspector takes — tools/list (names, annotations, no user_id) and
// tools/call (happy paths plus §9 error shapes), with the Voc data layer
// answered by the offline PostgREST stub.

import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from '../src/mcp/server'
import { errorResponse, jsonResponse, stubClient, tableOf, type CapturedRequest } from './helpers'

const USER_ID = '11111111-1111-1111-1111-111111111111'
// Valid RFC 4122 UUID (variant nibble 8, version 4) — z.uuid() at the tool
// input boundary rejects RFC-invalid ids (see 1.2-data-layer.md, issue 2).
const RECORD_ID = '22222222-2222-4222-8222-222222222222'
const ID_TRAVEL = '33333333-3333-3333-3333-333333333333'
const ID_WORK = '44444444-4444-4444-4444-444444444444'

const recordRow = {
  id: RECORD_ID,
  user_id: USER_ID,
  type: 'word',
  content: 'commute',
  meaning: 'to travel to work',
  source: 'podcast',
  notes: null,
  created_at: '2026-09-29T00:00:00Z',
  updated_at: '2026-09-29T00:00:00Z',
}

const visibleTags = [
  { id: ID_TRAVEL, name: 'travel', is_predefined: true, user_id: null, created_at: '' },
  { id: ID_WORK, name: 'work', is_predefined: true, user_id: null, created_at: '' },
]

const pgrst116 = () =>
  errorResponse(406, {
    message: 'JSON object requested, multiple (or no) rows returned',
    code: 'PGRST116',
  })

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function setup(routes: (req: CapturedRequest) => Response) {
  const { client: vocClient, requests } = stubClient(routes)
  const server = createServer(() => Promise.resolve({ client: vocClient, userId: USER_ID }))
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  cleanups.push(async () => {
    await client.close()
    await server.close()
  })
  return { client, requests }
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0]
  if (block?.type !== 'text' || typeof block.text !== 'string') {
    throw new Error(`expected a text content block, got ${JSON.stringify(result.content)}`)
  }
  return block.text
}

describe('tools/list', () => {
  it('lists exactly the six tools with §6 annotations and no user_id input', async () => {
    const { client } = await setup(() => {
      throw new Error('tools/list must not touch Voc')
    })

    const { tools } = await client.listTools()

    expect(tools.map(tool => tool.name).sort()).toEqual([
      'create_record',
      'delete_record',
      'get_record',
      'list_tags',
      'search_records',
      'update_record',
    ])
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy()
      expect(tool.description, tool.name).toBeTruthy()
      const props = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      )
      expect(props, `${tool.name} must not accept user_id`).not.toContain('user_id')
    }
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
    expect(byName.search_records.annotations?.readOnlyHint).toBe(true)
    expect(byName.get_record.annotations?.readOnlyHint).toBe(true)
    expect(byName.list_tags.annotations?.readOnlyHint).toBe(true)
    expect(byName.create_record.annotations?.readOnlyHint).toBe(false)
    expect(byName.update_record.annotations?.readOnlyHint).toBe(false)
    expect(byName.delete_record.annotations?.destructiveHint).toBe(true)
    expect(byName.delete_record.annotations?.readOnlyHint).toBe(false)
    for (const name of ['create_record', 'search_records', 'get_record', 'update_record', 'list_tags']) {
      expect(byName[name].annotations?.destructiveHint, name).not.toBe(true)
    }
  })
})

describe('create_record', () => {
  it('creates a record and returns it with its id', async () => {
    const { client, requests } = await setup(req => {
      if (req.method === 'GET' && tableOf(req) === 'tags') return jsonResponse(visibleTags)
      if (req.method === 'POST' && tableOf(req) === 'records') return jsonResponse(recordRow, 201)
      if (req.method === 'POST' && tableOf(req) === 'record_tags') return jsonResponse(null, 201)
      if (req.method === 'POST' && tableOf(req) === 'review_states') return jsonResponse(null, 201)
      throw new Error(`unexpected request: ${req.method} ${req.url.pathname}`)
    })

    const result = await client.callTool({
      name: 'create_record',
      arguments: {
        type: 'word',
        content: 'commute',
        meaning: 'to travel to work',
        source: 'podcast',
        tags: ['TRAVEL', 'work'],
      },
    })

    expect(result.isError).toBeFalsy()
    const message = firstText(result)
    expect(message).toContain('"commute"')
    expect(message).toContain(RECORD_ID)
    expect(message).toContain('TRAVEL, work')
    // Tag names were resolved to ids for the link rows — names, not UUIDs, at
    // the tool boundary (§6.7). resolveTagNames's GET /tags comes first in
    // `requests`, so the link insert is located by method+table, not position.
    const tagInsert = requests.find(req => req.method === 'POST' && tableOf(req) === 'record_tags')
    expect(tagInsert?.body).toEqual([
      { record_id: RECORD_ID, tag_id: ID_TRAVEL },
      { record_id: RECORD_ID, tag_id: ID_WORK },
    ])
  })

  it('rejects unknown tag names with close matches and a list_tags pointer', async () => {
    const { client, requests } = await setup(req => {
      if (req.method === 'GET' && tableOf(req) === 'tags') return jsonResponse(visibleTags)
      throw new Error(`unexpected request: ${req.method} ${req.url.pathname}`)
    })

    const result = await client.callTool({
      name: 'create_record',
      arguments: { type: 'word', content: 'commute', meaning: 'to travel to work', tags: ['travels'] },
    })

    expect(result.isError).toBe(true)
    expect(firstText(result)).toMatch(/Unknown tag\(s\): travels\. Close matches: travel\. Use list_tags/)
    // Nothing was written — no silent creation, no record insert.
    expect(requests.every(req => req.method === 'GET')).toBe(true)
  })
})

describe('search_records', () => {
  it('returns matching records and the total', async () => {
    const { client } = await setup(req => {
      if (tableOf(req) === 'records') {
        return jsonResponse(
          [{ ...recordRow, record_tags: [{ tags: visibleTags[0] }] }],
          200,
          { 'content-range': '0-0/1' },
        )
      }
      throw new Error(`unexpected request: ${req.method} ${req.url.pathname}`)
    })

    const result = await client.callTool({
      name: 'search_records',
      arguments: { query: 'commute' },
    })

    expect(result.isError).toBeFalsy()
    const message = firstText(result)
    expect(message).toContain('Total matching records: 1')
    expect(message).toContain('"commute"')
    expect(message).toContain(RECORD_ID)
    expect(message).not.toContain('Showing') // total == shown → no truncation note
  })

  it('says so explicitly when the total exceeds what was returned', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      ...recordRow,
      id: `00000000-0000-4000-8000-00000000000${i}`,
      record_tags: [],
    }))
    const { client } = await setup(req => {
      if (tableOf(req) === 'records') return jsonResponse(rows, 200, { 'content-range': '0-19/57' })
      throw new Error(`unexpected request: ${req.method} ${req.url.pathname}`)
    })

    const result = await client.callTool({ name: 'search_records', arguments: {} })

    expect(firstText(result)).toContain('Showing 20 of 57')
  })
})

describe('get_record', () => {
  it('returns the record with tags and review state', async () => {
    const { client } = await setup(req => {
      if (tableOf(req) === 'records') {
        return jsonResponse({ ...recordRow, record_tags: [{ tags: visibleTags[0] }] })
      }
      if (tableOf(req) === 'review_states') {
        return jsonResponse({ record_id: RECORD_ID, status: 'new', next_review_at: '2026-09-29T01:00:00Z' })
      }
      throw new Error(`unexpected request: ${req.method} ${req.url.pathname}`)
    })

    const result = await client.callTool({ name: 'get_record', arguments: { id: RECORD_ID } })

    expect(result.isError).toBeFalsy()
    const message = firstText(result)
    expect(message).toContain('"commute"')
    expect(message).toContain('Tags: travel')
    expect(message).toContain('Review: new, due 2026-09-29T01:00:00Z')
  })

  it('returns the structured not-found error pointing at search_records', async () => {
    const { client } = await setup(() => pgrst116())

    const result = await client.callTool({ name: 'get_record', arguments: { id: RECORD_ID } })

    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe(`Record ${RECORD_ID} not found. Use search_records to find valid ids.`)
  })
})

describe('update_record', () => {
  it('merges omitted fields, diffs tags, and returns the updated record', async () => {
    const { client, requests } = await setup(req => {
      if (req.method === 'GET' && tableOf(req) === 'records') {
        return jsonResponse({ ...recordRow, record_tags: [{ tags: visibleTags[0] }] })
      }
      if (req.method === 'GET' && tableOf(req) === 'review_states') {
        return jsonResponse({ record_id: RECORD_ID, status: 'new', next_review_at: '2026-09-29T01:00:00Z' })
      }
      if (req.method === 'GET' && tableOf(req) === 'tags') return jsonResponse(visibleTags)
      if (req.method === 'PATCH' && tableOf(req) === 'records') return jsonResponse(recordRow)
      if (req.method === 'GET' && tableOf(req) === 'record_tags') return jsonResponse([{ tag_id: ID_TRAVEL }])
      if (req.method === 'POST' && tableOf(req) === 'record_tags') return jsonResponse(null, 201)
      throw new Error(`unexpected request: ${req.method} ${req.url.pathname}`)
    })

    const result = await client.callTool({
      name: 'update_record',
      arguments: { id: RECORD_ID, meaning: 'to travel to and from work', tags: ['travel', 'work'] },
    })

    expect(result.isError).toBeFalsy()
    expect(firstText(result)).toContain('"commute"')

    // Omitted fields merged from the current row; meaning updated.
    const patch = requests.find(req => req.method === 'PATCH')
    expect(patch?.body).toEqual({
      type: 'word',
      content: 'commute',
      meaning: 'to travel to and from work',
      source: 'podcast',
      notes: null,
    })
    // Tag diff: travel kept, work added — only the addition is written.
    const add = requests.find(req => req.method === 'POST' && tableOf(req) === 'record_tags')
    expect(add?.body).toEqual([{ record_id: RECORD_ID, tag_id: ID_WORK }])
    expect(requests.some(req => req.method === 'DELETE' && tableOf(req) === 'record_tags')).toBe(false)
  })

  it('is a not-found error when the id is invisible', async () => {
    const { client } = await setup(() => pgrst116())

    const result = await client.callTool({
      name: 'update_record',
      arguments: { id: RECORD_ID, meaning: 'changed' },
    })

    expect(result.isError).toBe(true)
    expect(firstText(result)).toMatch(/not found/)
  })
})

describe('delete_record', () => {
  it('deletes and confirms with the content and the history warning', async () => {
    const { client, requests } = await setup(() => jsonResponse(recordRow))

    const result = await client.callTool({ name: 'delete_record', arguments: { id: RECORD_ID } })

    expect(result.isError).toBeFalsy()
    const message = firstText(result)
    expect(message).toContain(`Deleted word "commute"`)
    expect(message).toContain('cannot be recovered')
    expect(requests[0].method).toBe('DELETE')
    expect(requests[0].url.searchParams.get('id')).toBe(`eq.${RECORD_ID}`)
  })

  it('is a not-found error when the id is invisible', async () => {
    const { client } = await setup(() => pgrst116())

    const result = await client.callTool({ name: 'delete_record', arguments: { id: RECORD_ID } })

    expect(result.isError).toBe(true)
    expect(firstText(result)).toMatch(/not found/)
  })
})

describe('list_tags', () => {
  it('returns predefined and custom names and takes no input', async () => {
    const { client } = await setup(req => {
      if (tableOf(req) === 'tags') return jsonResponse(visibleTags)
      throw new Error(`unexpected request: ${req.method} ${req.url.pathname}`)
    })

    const result = await client.callTool({ name: 'list_tags', arguments: {} })

    expect(result.isError).toBeFalsy()
    const message = firstText(result)
    expect(message).toContain('Predefined tags (2): travel, work')
    expect(message).toContain('Custom tags (0): none')
  })

  it('surfaces PostgREST failures as isError results, not throws', async () => {
    const { client } = await setup(() =>
      errorResponse(503, { message: 'service unavailable' }),
    )

    const result = await client.callTool({ name: 'list_tags', arguments: {} })

    expect(result.isError).toBe(true)
    expect(firstText(result)).toMatch(/Voc request failed \(HTTP 503\): service unavailable/)
  })
})
