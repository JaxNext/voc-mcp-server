import { describe, expect, it } from 'vitest'
import { listTags, resolveTagNames, UnknownTagError } from '../src/voc/tags'
import { jsonResponse, stubClient, tableOf, type CapturedRequest } from './helpers'

const ID_TRAVEL = '33333333-3333-3333-3333-333333333333'
const ID_WORK = '44444444-4444-4444-4444-444444444444'
const ID_CUSTOM = '55555555-5555-5555-5555-555555555555'

// The RLS-visible set: all predefined tags plus the user's own custom tags.
const visibleTags = [
  { id: ID_TRAVEL, name: 'travel', is_predefined: true, user_id: null, created_at: '2026-01-01T00:00:00Z' },
  { id: ID_WORK, name: 'work', is_predefined: true, user_id: null, created_at: '2026-01-01T00:00:00Z' },
  { id: ID_CUSTOM, name: 'Work Trip', is_predefined: false, user_id: 'u', created_at: '2026-09-01T00:00:00Z' },
]

function tagsHandler(rows: unknown[] = visibleTags) {
  return (req: CapturedRequest) => {
    if (req.method === 'GET' && tableOf(req) === 'tags') return jsonResponse(rows)
    throw new Error(`unexpected request: ${req.method} ${req.url.pathname}`)
  }
}

describe('listTags', () => {
  it('returns predefined ∪ custom as { name, is_predefined }', async () => {
    const { client } = stubClient(tagsHandler())

    const tags = await listTags(client)

    expect(tags).toEqual([
      { name: 'travel', is_predefined: true },
      { name: 'work', is_predefined: true },
      { name: 'Work Trip', is_predefined: false },
    ])
  })

  it('orders predefined first, then alphabetical (Voc\'s load())', async () => {
    const { client, requests } = stubClient(tagsHandler())

    await listTags(client)

    expect(tableOf(requests[0])).toBe('tags')
    expect(requests[0].url.searchParams.get('select')).toBe('id,name,is_predefined')
    expect(requests[0].url.searchParams.get('order')).toBe('is_predefined.desc,name')
  })
})

describe('resolveTagNames', () => {
  it('matches names case-insensitively and preserves request order', async () => {
    const { client, requests } = stubClient(tagsHandler())

    const ids = await resolveTagNames(client, ['WORK', 'Work Trip'])

    expect(ids).toEqual([ID_WORK, ID_CUSTOM])
    expect(requests).toHaveLength(1)
    expect(tableOf(requests[0])).toBe('tags')
  })

  it('collapses duplicates that differ only in case', async () => {
    const { client } = stubClient(tagsHandler())

    const ids = await resolveTagNames(client, ['travel', 'TRAVEL', 'Travel'])

    expect(ids).toEqual([ID_TRAVEL])
  })

  it('returns [] for empty input without any request', async () => {
    const { client, requests } = stubClient(tagsHandler())

    const ids = await resolveTagNames(client, [])

    expect(ids).toEqual([])
    expect(requests).toHaveLength(0)
  })

  it('throws UnknownTagError with close matches and a list_tags pointer (§14 R2)', async () => {
    const { client, requests } = stubClient(tagsHandler())

    await expect(resolveTagNames(client, ['travels'])).rejects.toThrow(UnknownTagError)
    await expect(resolveTagNames(client, ['travels'])).rejects.toThrow(
      /Unknown tag\(s\): travels\. Close matches: travel\. Use list_tags to list all tags\./,
    )

    // No silent creation — a read of tags only, never a POST.
    expect(requests.every(r => r.method === 'GET')).toBe(true)
  })

  it('lists all known tags when no close match exists', async () => {
    const { client } = stubClient(tagsHandler())

    const error = await resolveTagNames(client, ['zzzq']).catch(e => e)
    expect(error).toBeInstanceOf(UnknownTagError)
    expect(error.message).toContain('Known tags: travel, work, Work Trip')
    expect(error.message).toContain('Use list_tags')
    expect(error.unknown).toEqual(['zzzq'])
    expect(error.known).toEqual(['travel', 'work', 'Work Trip'])
  })

  it('fails the whole call when one name among several is unknown', async () => {
    const { client } = stubClient(tagsHandler())

    const error = await resolveTagNames(client, ['work', 'zzzq']).catch(e => e)
    expect(error).toBeInstanceOf(UnknownTagError)
    expect(error.unknown).toEqual(['zzzq'])
  })
})
