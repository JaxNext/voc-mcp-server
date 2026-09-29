// content[] formatting helpers (§4): every tool result is a single text
// block, phrased for an assistant reading it in a chat transcript.

import type { CallToolResult, TextContent } from '@modelcontextprotocol/server'
import type { RecordDetail, RecordListResult, RecordRow, RecordType } from '../../voc/records'
import type { TagInfo } from '../../voc/tags'

export function text(content: string): TextContent {
  return { type: 'text', text: content }
}

export function textResult(content: string): CallToolResult {
  return { content: [text(content)] }
}

/** Short type label used inline, e.g. `word "commute"`. */
function typeLabel(type: RecordType): string {
  return type
}

export function formatRecord(record: RecordRow, tagNames: string[] = []): string {
  const lines = [
    `${typeLabel(record.type)} "${record.content}" (id: ${record.id})`,
    `Meaning: ${record.meaning}`,
  ]
  if (record.source) lines.push(`Source: ${record.source}`)
  if (record.notes) lines.push(`Notes: ${record.notes}`)
  if (tagNames.length > 0) lines.push(`Tags: ${tagNames.join(', ')}`)
  return lines.join('\n')
}

export function formatRecordDetail(detail: RecordDetail): string {
  const lines = formatRecord(detail.record, detail.record.tags.map(tag => tag.name)).split('\n')
  const review = detail.reviewState
  lines.push(
    review
      ? `Review: ${review.status}, due ${review.next_review_at}`
      : 'Review: no review state recorded.',
  )
  return lines.join('\n')
}

export function formatSearchResult(
  result: RecordListResult,
  shown: number,
): string {
  const lines: string[] = [`Total matching records: ${result.total} (page ${result.page}).`]
  if (result.records.length === 0) {
    // Empty here means "no matches for these filters" — never "the user has
    // no records" (§9); an RLS-invisible read surfaces elsewhere as not-found.
    lines.push('No records matched the given filters. Try fewer or broader filters.')
    return lines.join('\n')
  }
  for (const record of result.records) {
    const tags = record.tags.map(tag => tag.name)
    lines.push(`- ${typeLabel(record.type)} "${record.content}" — ${record.meaning} (id: ${record.id}${tags.length > 0 ? `, tags: ${tags.join(', ')}` : ''})`)
  }
  if (result.total > shown) {
    lines.push(
      `Showing ${shown} of ${result.total}. Narrow the filters, raise the page, or increase pageSize to see the rest.`,
    )
  }
  return lines.join('\n')
}

export function formatTags(tags: TagInfo[]): string {
  const predefined = tags.filter(tag => tag.is_predefined).map(tag => tag.name)
  const custom = tags.filter(tag => !tag.is_predefined).map(tag => tag.name)
  const lines = [
    `Predefined tags (${predefined.length}): ${predefined.join(', ') || 'none'}`,
    `Custom tags (${custom.length}): ${custom.join(', ') || 'none'}`,
    'Use these names (any capitalization) with create_record, update_record and search_records.',
  ]
  return lines.join('\n')
}
