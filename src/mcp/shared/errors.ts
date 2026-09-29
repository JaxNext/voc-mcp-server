// Tool-result error helpers (§9): errors are returned as `isError: true`
// results, never thrown into the transport, and every message names a next
// step. 200+[] and PGRST116 are "not found" — never "the user has no
// records".

import type { CallToolResult } from '@modelcontextprotocol/server'
import { PostgrestError } from '../../voc/postgrest'
import { UnknownTagError } from '../../voc/tags'
import { text } from './result'

export function errorResult(message: string): CallToolResult {
  return { content: [text(message)], isError: true }
}

/** §9: the structured not-found message, pointing at search_records. */
export function notFoundResult(id: string): CallToolResult {
  return errorResult(`Record ${id} not found. Use search_records to find valid ids.`)
}

/** UnknownTagError's message already lists close matches and names list_tags. */
export function unknownTagsResult(error: UnknownTagError): CallToolResult {
  return errorResult(error.message)
}

/** PostgREST failure: status + message/details, not a raw dump (§9). */
export function postgrestErrorResult(error: PostgrestError): CallToolResult {
  return errorResult(
    `Voc request failed (HTTP ${error.status}): ${error.message}. ` +
    'Check the input and retry; if it persists, the Voc project may be unreachable.',
  )
}

export function unexpectedErrorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return errorResult(`Unexpected error: ${message}. Retry the tool call.`)
}

/** Map a thrown data-layer error to its §9 tool-result shape. */
export function toErrorResult(error: unknown): CallToolResult {
  if (error instanceof UnknownTagError) return unknownTagsResult(error)
  if (error instanceof PostgrestError) return postgrestErrorResult(error)
  return unexpectedErrorResult(error)
}
