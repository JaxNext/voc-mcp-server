// Record read/write semantics mirroring Voc's useRecords.ts exactly
// (tech-design §5.3). Voc's record writes are not a single insert — there is
// no database trigger — so this module reproduces the composable's composite
// operations against PostgREST, with no MCP coupling (§4).

import type { PostgrestClient } from './postgrest'

export type RecordType = 'word' | 'phrase' | 'sentence'
export type RecordSort = 'newest' | 'oldest' | 'alphabetical'
export type LearningStatus = 'new' | 'learning' | 'mastered'

export interface RecordRow {
  id: string
  user_id: string
  type: RecordType
  content: string
  meaning: string
  source: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface TagRow {
  id: string
  user_id: string | null
  name: string
  is_predefined: boolean
  created_at: string
}

export interface RecordWithTags extends RecordRow {
  tags: TagRow[]
}

/** The slice of `review_states` get_record reports (§6.3). */
export interface ReviewStateSummary {
  record_id: string
  status: LearningStatus
  next_review_at: string
}

/**
 * Full record payload. `source`/`notes` are nullable so an explicit null
 * clears them (§6.4). `tagIds` are resolved UUIDs — names → ids happens in
 * tags.ts (§6.7).
 */
export interface RecordInput {
  type: RecordType
  content: string
  meaning: string
  source: string | null
  notes: string | null
  tagIds: string[]
}

export interface RecordListFilters {
  search?: string
  type?: RecordType | 'all'
  /** Union semantics: records carrying ANY of these tags. */
  tagIds?: string[]
  sort?: RecordSort
  page?: number // 1-based
  pageSize?: number
}

export interface RecordListResult {
  records: RecordWithTags[]
  total: number
  hasMore: boolean
  page: number
}

export interface RecordDetail {
  record: RecordWithTags
  /** Null for legacy records created before the review loop existed. */
  reviewState: ReviewStateSummary | null
}

export const DEFAULT_PAGE_SIZE = 20

const RECORD_SELECT = '*,record_tags(tags(*))'

// PostgREST `or=` reserves commas and parens as filter syntax; strip them so
// user input can never inject additional branches (§5.3, mirrors Voc's
// sanitizeSearchTerm).
export function sanitizeSearchTerm(term: string): string {
  return term.replace(/[,()]/g, ' ').trim()
}

// Embed shape of `record_tags(tags(*))`; tags can be null when the embed is
// RLS-filtered (e.g. a tag row this session may no longer read).
interface TagEmbed {
  tags: TagRow | null
}
interface RecordQueryRow extends RecordRow {
  record_tags: TagEmbed[] | null
}

function toRecordWithTags(row: RecordQueryRow): RecordWithTags {
  const { record_tags, ...record } = row
  return { ...record, tags: (record_tags ?? []).flatMap(embed => (embed.tags ? [embed.tags] : [])) }
}

// Which composite-create step failed — named in the error message (§9).
type CreateStep = 'record_tags' | 'review_states'

const CREATE_STEP_LABEL: Record<CreateStep, string> = {
  record_tags: 'linking tags',
  review_states: 'creating the review state',
}

class CreateStepError extends Error {
  readonly step: CreateStep
  readonly reason: string

  constructor(step: CreateStep, error: unknown) {
    super(step)
    this.name = 'CreateStepError'
    this.step = step
    this.reason = error instanceof Error ? error.message : String(error)
  }
}

/**
 * Create — 3-step composite (§5.3): records → record_tags (only if tags) →
 * review_states with no fields, so DB defaults (`status 'new'`,
 * `next_review_at now()`) make the record due immediately. Omitting step 3
 * would leave the record permanently out of Voc's review queue.
 *
 * Any failure after step 1 deletes the record again (FK cascades clean up the
 * rest) and the error says which step failed and that nothing was saved.
 */
export async function createRecord(
  client: PostgrestClient,
  args: { userId: string; input: RecordInput },
): Promise<RecordRow> {
  const { userId, input } = args
  const { tagIds, ...fields } = input

  const record = await client.insert<RecordRow>(
    'records',
    { ...fields, user_id: userId },
    { single: true },
  )
  if (!record) throw new Error('Record insert returned no row')

  try {
    if (tagIds.length > 0) {
      try {
        await client.insert('record_tags', tagIds.map(tag_id => ({ record_id: record.id, tag_id })))
      } catch (error) {
        throw new CreateStepError('record_tags', error)
      }
    }
    try {
      // Exactly one field — the row relies entirely on DB defaults.
      await client.insert('review_states', { record_id: record.id })
    } catch (error) {
      throw new CreateStepError('review_states', error)
    }
  } catch (error) {
    if (!(error instanceof CreateStepError)) throw error

    let cleanupFailure: string | null = null
    try {
      await client.deleteOne('records', [`id=eq.${record.id}`])
    } catch (rollbackError) {
      cleanupFailure = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
    }

    if (cleanupFailure) {
      throw new Error(
        `Create failed at step ${error.step} (${CREATE_STEP_LABEL[error.step]}): ${error.reason}. ` +
        `Cleanup also failed (${cleanupFailure}) — the half-created record ${record.id} may still exist.`,
      )
    }
    throw new Error(
      `Create failed at step ${error.step} (${CREATE_STEP_LABEL[error.step]}): ${error.reason}. ` +
      'The record was deleted — nothing was saved.',
    )
  }

  return record
}

/**
 * List/search — mirrors Voc's fetchRecords (§5.3). Tag filtering is a
 * two-step union: resolve record ids from `record_tags` first, then
 * `id=in.(…)` — a single `!inner` join would duplicate records carrying
 * several matching tags and break the exact count used for pagination.
 */
export async function searchRecords(
  client: PostgrestClient,
  filters: RecordListFilters = {},
): Promise<RecordListResult> {
  const {
    search,
    type = 'all',
    tagIds = [],
    sort = 'newest',
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  } = filters

  let recordIdFilter: string[] | undefined
  if (tagIds.length > 0) {
    const { rows } = await client.select<{ record_id: string }>('record_tags', {
      select: 'record_id',
      filters: [`tag_id=in.(${tagIds.join(',')})`],
    })
    recordIdFilter = [...new Set(rows.map(row => row.record_id))]
    if (recordIdFilter.length === 0) {
      return { records: [], total: 0, hasMore: false, page }
    }
  }

  const queryFilters: string[] = []
  if (type !== 'all') queryFilters.push(`type=eq.${type}`)
  if (recordIdFilter) queryFilters.push(`id=in.(${recordIdFilter.join(',')})`)

  const term = search ? sanitizeSearchTerm(search) : ''
  if (term) {
    // PostgREST URL syntax uses `*` as the ilike wildcard; the sanitized term
    // is percent-encoded when the query string is built.
    queryFilters.push(`or=(content.ilike.*${term}*,meaning.ilike.*${term}*)`)
  }

  // Tiebreak on id so equal created_at/content values paginate stably (§6.2).
  const order =
    sort === 'newest' ? 'created_at.desc,id' : sort === 'oldest' ? 'created_at.asc,id' : 'content,id'

  const offset = (page - 1) * pageSize
  const { rows, total } = await client.select<RecordQueryRow>('records', {
    select: RECORD_SELECT,
    filters: queryFilters,
    order,
    limit: pageSize,
    offset,
    count: true,
  })

  const records = rows.map(toRecordWithTags)
  const resolvedTotal = total ?? offset + records.length
  return {
    records,
    total: resolvedTotal,
    hasMore: offset + records.length < resolvedTotal,
    page,
  }
}

/**
 * One record + tags + review state (`status`, `next_review_at` — read-only
 * context that helps the assistant avoid re-explaining a mastered word,
 * §6.3). Null when the id does not exist or is RLS-invisible.
 */
export async function getRecord(client: PostgrestClient, id: string): Promise<RecordDetail | null> {
  const row = await client.selectMaybeOne<RecordQueryRow>('records', {
    select: RECORD_SELECT,
    filters: [`id=eq.${id}`],
  })
  if (!row) return null

  const reviewState = await client.selectMaybeOne<ReviewStateSummary>('review_states', {
    select: 'record_id,status,next_review_at',
    filters: [`record_id=eq.${id}`],
  })
  return { record: toRecordWithTags(row), reviewState }
}

/**
 * Update — PATCH the full `{type, content, meaning, source, notes}` set (the
 * tool layer merges omitted fields before calling; §6.4), then sync tags as a
 * diff: remove only deselected, add only new — never delete-all-then-insert,
 * so a failed tag write can never wipe existing associations.
 *
 * Returns the updated row (without fresh tags), or null when the id does not
 * exist or is RLS-invisible (§9).
 */
export async function updateRecord(
  client: PostgrestClient,
  args: { id: string; input: RecordInput },
): Promise<RecordRow | null> {
  const { id, input } = args
  const { tagIds, ...fields } = input

  const updated = await client.update<RecordRow>('records', [`id=eq.${id}`], fields)
  if (!updated) return null

  const { rows } = await client.select<{ tag_id: string }>('record_tags', {
    select: 'tag_id',
    filters: [`record_id=eq.${id}`],
  })
  const currentIds = rows.map(row => row.tag_id)
  const toRemove = currentIds.filter(tagId => !tagIds.includes(tagId))
  const toAdd = tagIds.filter(tagId => !currentIds.includes(tagId))

  if (toRemove.length > 0) {
    await client.deleteWhere('record_tags', [
      `record_id=eq.${id}`,
      `tag_id=in.(${toRemove.join(',')})`,
    ])
  }
  if (toAdd.length > 0) {
    await client.insert('record_tags', toAdd.map(tag_id => ({ record_id: id, tag_id })))
  }

  return updated
}

/**
 * Delete — relies on `on delete cascade` removing record_tags, review_states
 * and review_events. Deleting a record destroys its review history
 * irrecoverably (§5.3). Returns the deleted row so the caller can confirm by
 * content; null when not found.
 */
export async function deleteRecord(client: PostgrestClient, id: string): Promise<RecordRow | null> {
  return client.deleteOne<RecordRow>('records', [`id=eq.${id}`])
}
