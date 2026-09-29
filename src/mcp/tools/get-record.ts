import type { McpServer } from '@modelcontextprotocol/server'
import { getRecord } from '../../voc/records'
import { notFoundResult, toErrorResult } from '../shared/errors'
import { formatRecordDetail, textResult } from '../shared/result'
import { RecordIdInputSchema } from '../shared/schemas'
import type { VocSessionFactory } from '../shared/session'

export function registerGetRecord(server: McpServer, voc: VocSessionFactory): void {
  server.registerTool(
    'get_record',
    {
      title: 'Get vocabulary record',
      description:
        'Fetch one Voc record by id, including its tags and review state (status and next due time) — ' +
        'useful context for avoiding re-explaining a word the user already mastered. ' +
        'Returns a structured not-found error when the id does not exist or is not visible to the caller; ' +
        'it does NOT list records — use search_records for that.',
      inputSchema: RecordIdInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async args => {
      try {
        const { client } = await voc()
        const detail = await getRecord(client, args.id)
        if (!detail) return notFoundResult(args.id)
        return textResult(formatRecordDetail(detail))
      } catch (error) {
        return toErrorResult(error)
      }
    },
  )
}
