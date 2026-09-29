// Tag listing and name → id resolution (tech-design §6.7, §14 R2).
//
// The tools accept and return tag *names*, not UUIDs — an assistant cannot
// know a UUID before it asks. Names are matched case-insensitively against
// the visible tag set; unknown names throw UnknownTagError (listing close
// matches and pointing at list_tags). No silent tag creation.

import type { PostgrestClient } from './postgrest'

export interface TagInfo {
  name: string
  is_predefined: boolean
}

interface TagQueryRow {
  id: string
  name: string
  is_predefined: boolean
}

/**
 * Thrown by resolveTagNames when a name does not match the visible set
 * (predefined ∪ the user's custom tags). The message lists close matches
 * (falling back to all known tags) and points at list_tags.
 */
export class UnknownTagError extends Error {
  readonly unknown: string[]
  readonly known: string[]

  constructor(unknown: string[], known: string[]) {
    super(formatUnknownMessage(unknown, known))
    this.name = 'UnknownTagError'
    this.unknown = unknown
    this.known = known
  }
}

function formatUnknownMessage(unknown: string[], known: string[]): string {
  const lowerUnknown = unknown.map(name => name.toLowerCase())
  const close = known.filter(name => {
    const lower = name.toLowerCase()
    return lower !== '' && lowerUnknown.some(u => lower.includes(u) || u.includes(lower))
  })
  const hint = close.length > 0 ? `Close matches: ${close.join(', ')}.` : `Known tags: ${known.join(', ')}.`
  return `Unknown tag(s): ${unknown.join(', ')}. ${hint} Use list_tags to list all tags.`
}

/**
 * Predefined + custom tags, as the RLS-visible set (§5.1) — one query, same
 * as Voc's useTags().load(): predefined first, then alphabetical.
 */
export async function listTags(client: PostgrestClient): Promise<TagInfo[]> {
  const { rows } = await client.select<TagQueryRow>('tags', {
    select: 'id,name,is_predefined',
    order: 'is_predefined.desc,name',
  })
  return rows.map(({ name, is_predefined }) => ({ name, is_predefined }))
}

/**
 * Resolve tag names to ids, case-insensitively, in request order. Duplicate
 * names (differing only in case) collapse to one id. Empty input returns []
 * without a request. Unknown names throw UnknownTagError — nothing is
 * created silently (§14 R2).
 */
export async function resolveTagNames(client: PostgrestClient, names: string[]): Promise<string[]> {
  if (names.length === 0) return []

  const { rows } = await client.select<TagQueryRow>('tags', { select: 'id,name' })

  const byLower = new Map<string, TagQueryRow>()
  for (const row of rows) {
    const lower = row.name.toLowerCase()
    if (!byLower.has(lower)) byLower.set(lower, row)
  }

  const unknown: string[] = []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const lower = name.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    const row = byLower.get(lower)
    if (row) ids.push(row.id)
    else unknown.push(name)
  }

  if (unknown.length > 0) {
    throw new UnknownTagError(unknown, rows.map(row => row.name))
  }
  return ids
}
