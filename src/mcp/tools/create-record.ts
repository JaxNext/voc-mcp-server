import type { McpServer } from '@modelcontextprotocol/server'
import { createRecord } from '../../voc/records'
import { resolveTagNames } from '../../voc/tags'
import { toErrorResult } from '../shared/errors'
import { formatRecord, textResult } from '../shared/result'
import { CreateRecordSchema } from '../shared/schemas'
import type { VocSessionFactory } from '../shared/session'

export function registerCreateRecord(server: McpServer, voc: VocSessionFactory): void {
  server.registerTool(
    'create_record',
    {
      title: 'Create vocabulary record',
      description:
        'Capture a new vocabulary record (word, phrase, or sentence) in Voc. ' +
        'Returns the created record including its id, so it can be referenced or amended later. ' +
        'The record enters the review queue immediately; it does NOT grade or schedule reviews — that happens in Voc.',
      inputSchema: CreateRecordSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async args => {
      try {
        const { client, userId } = await voc()
        const tagIds = await resolveTagNames(client, args.tags)
        const record = await createRecord(client, {
          userId,
          input: {
            type: args.type,
            content: args.content,
            meaning: args.meaning,
            source: args.source ?? null,
            notes: args.notes ?? null,
            tagIds,
          },
        })
        return textResult(formatRecord(record, args.tags))
      } catch (error) {
        return toErrorResult(error)
      }
    },
  )
}
