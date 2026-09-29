import { describe, expect, it } from 'vitest'
import { CreateRecordSchema, UpdateRecordSchema } from '../src/mcp/shared/schemas'
import {
  createRecord,
  deleteRecord,
  updateRecord,
  type RecordInput,
} from '../src/voc/records'
import { errorResponse, jsonResponse, stubClient, tableOf } from './helpers'

const USER_ID = '11111111-1111-1111-1111-111111111111'
const RECORD_ID = '22222222-2222-2222-2222-222222222222'
const TAG_A = '33333333-3333-3333-3333-333333333333'
const TAG_B = '44444444-4444-4444-4444-444444444444'
const TAG_C = '55555555-5555-5555-5555-555555555555'

const baseInput: RecordInput = {
  type: 'word',
  content: 'commute',
  meaning: 'to travel to work',
  source: 'podcast',
  notes: null,
  tagIds: [TAG_A, TAG_B],
}

const recordRow = { ...baseInput, id: RECORD_ID, user_id: USER_ID, tagIds: undefined }

describe('createRecord', () => {
  it('issues the 3-step composite: records → record_tags → review_states', async () => {
    const { client, requests } = stubClient(r => {
      if (r.method === 'POST' && tableOf(r) === 'records') return jsonResponse(recordRow, 201)
      if (r.method === 'POST' && tableOf(r) === 'record_tags') return jsonResponse(null, 201)
      if (r.method === 'POST' && tableOf(r) === 'review_states') return jsonResponse(null, 201)
      throw new Error(`unexpected request: ${r.method} ${r.url.pathname}`)
    })

    const result = await createRecord(client, { userId: USER_ID, input: baseInput })

    expect(result).toEqual(recordRow)
    expect(requests).toHaveLength(3)

    // Step 1 — the record, with user_id from the JWT sub claim and no tagIds
    // key leaking into the payload.
    expect(requests[0].method).toBe('POST')
    expect(tableOf(requests[0])).toBe('records')
    expect(requests[0].body).toEqual({
      type: 'word',
      content: 'commute',
      meaning: 'to travel to work',
      source: 'podcast',
      notes: null,
      user_id: USER_ID,
    })

    // Step 2 — one record_tags row per tag.
    expect(tableOf(requests[1])).toBe('record_tags')
    expect(requests[1].body).toEqual([
      { record_id: RECORD_ID, tag_id: TAG_A },
      { record_id: RECORD_ID, tag_id: TAG_B },
    ])

    // Step 3 — review_states with NO fields beyond record_id: DB defaults
    // (status 'new', next_review_at now()) make it due immediately (§5.3).
    expect(tableOf(requests[2])).toBe('review_states')
    expect(requests[2].body).toEqual({ record_id: RECORD_ID })
    expect(Object.keys(requests[2].body as object)).toEqual(['record_id'])
  })

  it('sends apikey + Bearer token headers on every request', async () => {
    const { client, requests } = stubClient(() => jsonResponse(recordRow, 201))
    await createRecord(client, { userId: USER_ID, input: { ...baseInput, tagIds: [] } })
    for (const req of requests) {
      expect(req.headers.apikey).toBe('test-anon-key')
      expect(req.headers.authorization).toBe('Bearer test-user-jwt')
    }
  })

  it('skips the record_tags insert when there are no tags', async () => {
    const { client, requests } = stubClient(r =>
      tableOf(r) === 'records' ? jsonResponse(recordRow, 201) : jsonResponse(null, 201),
    )
    await createRecord(client, { userId: USER_ID, input: { ...baseInput, tagIds: [] } })
    expect(requests).toHaveLength(2)
    expect(tableOf(requests[0])).toBe('records')
    expect(tableOf(requests[1])).toBe('review_states')
  })

  it('rolls back on step-2 (record_tags) failure and says nothing was saved', async () => {
    const { client, requests } = stubClient(r => {
      if (tableOf(r) === 'records' && r.method === 'POST') return jsonResponse(recordRow, 201)
      if (tableOf(r) === 'records' && r.method === 'DELETE') return jsonResponse(recordRow)
      if (tableOf(r) === 'record_tags') {
        return errorResponse(400, { message: 'insert or update on table violates constraint', code: '23505' })
      }
      throw new Error('review_states must never be reached')
    })

    await expect(createRecord(client, { userId: USER_ID, input: baseInput })).rejects.toThrow(
      /record_tags.*nothing was saved/s,
    )

    // Rollback: the record was deleted again.
    const rollback = requests.find(r => r.method === 'DELETE' && tableOf(r) === 'records')
    expect(rollback).toBeDefined()
    expect(rollback?.url.searchParams.get('id')).toBe(`eq.${RECORD_ID}`)
    expect(rollback?.headers.prefer).toBe('return=representation')
    // Step 3 never ran.
    expect(requests.some(r => tableOf(r) === 'review_states')).toBe(false)
  })

  it('rolls back on step-3 (review_states) failure and says nothing was saved', async () => {
    const { client, requests } = stubClient(r => {
      if (tableOf(r) === 'records' && r.method === 'POST') return jsonResponse(recordRow, 201)
      if (tableOf(r) === 'records' && r.method === 'DELETE') return jsonResponse(recordRow)
      if (tableOf(r) === 'record_tags') return jsonResponse(null, 201)
      if (tableOf(r) === 'review_states') return errorResponse(400, { message: 'rls check failed' })
      throw new Error(`unexpected request: ${r.method} ${r.url.pathname}`)
    })

    await expect(createRecord(client, { userId: USER_ID, input: baseInput })).rejects.toThrow(
      /review_states.*nothing was saved/s,
    )
    const rollback = requests.find(r => r.method === 'DELETE' && tableOf(r) === 'records')
    expect(rollback).toBeDefined()
  })

  it('reports when the rollback itself fails', async () => {
    const { client } = stubClient(r => {
      if (tableOf(r) === 'records' && r.method === 'POST') return jsonResponse(recordRow, 201)
      if (tableOf(r) === 'record_tags') return errorResponse(400, { message: 'tag insert failed' })
      return errorResponse(500, { message: 'delete failed' })
    })

    await expect(createRecord(client, { userId: USER_ID, input: baseInput })).rejects.toThrow(
      new RegExp(`Cleanup also failed.*${RECORD_ID} may still exist`, 's'),
    )
  })
})

describe('updateRecord', () => {
  it('PATCHes the full field set and diffs tags (remove deselected, add new)', async () => {
    const updatedRow = { ...recordRow, content: 'commute (v.)' }
    const { client, requests } = stubClient(r => {
      if (r.method === 'PATCH' && tableOf(r) === 'records') return jsonResponse(updatedRow)
      if (r.method === 'GET' && tableOf(r) === 'record_tags') {
        return jsonResponse([{ tag_id: TAG_A }, { tag_id: TAG_B }])
      }
      if (r.method === 'DELETE' && tableOf(r) === 'record_tags') return jsonResponse(null, 204)
      if (r.method === 'POST' && tableOf(r) === 'record_tags') return jsonResponse(null, 201)
      throw new Error(`unexpected request: ${r.method} ${r.url.pathname}`)
    })

    const input: RecordInput = { ...baseInput, content: 'commute (v.)', tagIds: [TAG_B, TAG_C] }
    const result = await updateRecord(client, { id: RECORD_ID, input })

    expect(result).toEqual(updatedRow)

    // Full set on the PATCH — omitted-field merging happened upstream (§6.4).
    const patch = requests[0]
    expect(patch.method).toBe('PATCH')
    expect(tableOf(patch)).toBe('records')
    expect(patch.url.searchParams.get('id')).toBe(`eq.${RECORD_ID}`)
    expect(patch.body).toEqual({
      type: 'word',
      content: 'commute (v.)',
      meaning: 'to travel to work',
      source: 'podcast',
      notes: null,
    })
    expect(Object.keys(patch.body as object).sort()).toEqual(
      ['content', 'meaning', 'notes', 'source', 'type'],
    )

    // Current associations read first…
    expect(requests[1].method).toBe('GET')
    expect(tableOf(requests[1])).toBe('record_tags')
    expect(requests[1].url.searchParams.get('record_id')).toBe(`eq.${RECORD_ID}`)

    // …then only the deselected tag is removed (TAG_A)…
    expect(requests[2].method).toBe('DELETE')
    expect(tableOf(requests[2])).toBe('record_tags')
    expect(requests[2].url.searchParams.get('tag_id')).toBe(`in.(${TAG_A})`)

    // …and only the new one added (TAG_C); TAG_B untouched.
    expect(requests[3].method).toBe('POST')
    expect(requests[3].body).toEqual([{ record_id: RECORD_ID, tag_id: TAG_C }])
  })

  it('makes no tag writes when the tag set is unchanged', async () => {
    const { client, requests } = stubClient(r => {
      if (r.method === 'PATCH') return jsonResponse(recordRow)
      if (r.method === 'GET' && tableOf(r) === 'record_tags') {
        return jsonResponse([{ tag_id: TAG_A }, { tag_id: TAG_B }])
      }
      throw new Error(`unexpected request: ${r.method} ${r.url.pathname}`)
    })

    await updateRecord(client, { id: RECORD_ID, input: baseInput })
    expect(requests).toHaveLength(2) // PATCH + tag read only
  })

  it('returns null on a zero-row update (PGRST116) and touches no tags', async () => {
    const { client, requests } = stubClient(() =>
      errorResponse(406, {
        message: 'JSON object requested, multiple (or no) rows returned',
        code: 'PGRST116',
      }),
    )

    const result = await updateRecord(client, { id: RECORD_ID, input: baseInput })
    expect(result).toBeNull()
    expect(requests).toHaveLength(1) // the PATCH only
  })
})

describe('deleteRecord', () => {
  it('DELETEs the record and returns the deleted row for the confirmation message', async () => {
    const { client, requests } = stubClient(() => jsonResponse(recordRow))

    const result = await deleteRecord(client, RECORD_ID)

    expect(result).toEqual(recordRow)
    expect(requests).toHaveLength(1)
    const req = requests[0]
    expect(req.method).toBe('DELETE')
    expect(tableOf(req)).toBe('records')
    expect(req.url.searchParams.get('id')).toBe(`eq.${RECORD_ID}`)
    // Cascades (record_tags, review_states, review_events) are DB-side; the
    // representation preference returns the row for naming its content.
    expect(req.headers.prefer).toBe('return=representation')
  })

  it('maps PGRST116 (zero rows) to null — not found, never "no records"', async () => {
    const { client } = stubClient(() =>
      errorResponse(406, { message: 'no rows', code: 'PGRST116' }),
    )
    expect(await deleteRecord(client, RECORD_ID)).toBeNull()
  })
})

describe('Zod boundaries (Voc limits, §5.3/§6.1)', () => {
  it('rejects content of 501 characters and accepts 500', () => {
    expect(CreateRecordSchema.safeParse({ ...validCreate(), content: 'a'.repeat(501) }).success).toBe(false)
    expect(CreateRecordSchema.safeParse({ ...validCreate(), content: 'a'.repeat(500) }).success).toBe(true)
  })

  it('rejects meaning of 2001 characters and accepts 2000', () => {
    expect(CreateRecordSchema.safeParse({ ...validCreate(), meaning: 'b'.repeat(2001) }).success).toBe(false)
    expect(CreateRecordSchema.safeParse({ ...validCreate(), meaning: 'b'.repeat(2000) }).success).toBe(true)
  })

  it('rejects an invalid type and empty content/meaning after trim', () => {
    expect(CreateRecordSchema.safeParse({ ...validCreate(), type: 'paragraph' }).success).toBe(false)
    expect(CreateRecordSchema.safeParse({ ...validCreate(), content: '   ' }).success).toBe(false)
    expect(CreateRecordSchema.safeParse({ ...validCreate(), meaning: '' }).success).toBe(false)
  })

  it('keeps source/notes at their limits and allows explicit null on update', () => {
    expect(UpdateRecordSchema.safeParse({ id: VALID_UUID, source: 'c'.repeat(501) }).success).toBe(false)
    expect(UpdateRecordSchema.safeParse({ id: VALID_UUID, notes: 'd'.repeat(4001) }).success).toBe(false)
    expect(UpdateRecordSchema.safeParse({ id: VALID_UUID, source: null, notes: null }).success).toBe(true)
    expect(UpdateRecordSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false)
  })
})

// A UUID valid under RFC 4122 (version nibble + 89ab variant) — z.uuid()
// enforces both, so the row-id constants above cannot be reused here.
const VALID_UUID = '22222222-2222-4222-8222-222222222222'

function validCreate() {
  return { type: 'word', content: 'commute', meaning: 'to travel to work' }
}
