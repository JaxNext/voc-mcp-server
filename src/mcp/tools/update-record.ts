import type { McpServer } from '@modelcontextprotocol/server'
import { getRecord, updateRecord } from '../../voc/records'
import { resolveTagNames } from '../../voc/tags'
import { notFoundResult, toErrorResult } from '../shared/errors'
import { formatRecord, textResult } from '../shared/result'
import { UpdateRecordSchema } from '../shared/schemas'
import type { VocSessionFactory } from '../shared/session'

export function registerUpdateRecord(server: McpServer, voc: VocSessionFactory): void {
  server.registerTool(
    'update_record',
    {
      title: 'Update vocabulary record',
      description:
        'Edit an existing Voc record: type, content, meaning, source, notes, and tags. ' +
        'Omitted fields stay unchanged; passing null for source or notes clears them; ' +
        'passing tags replaces the tag set ([] removes all — omit tags to leave associations alone). ' +
        'Returns the updated record. Does NOT touch review scheduling — grading stays in Voc.',
      inputSchema: UpdateRecordSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async args => {
      try {
        const { client } = await voc()

        // Read-modify-write: Voc requires the full {type, content, meaning,
        // source, notes} set on update (§6.4), so omitted fields are merged
        // from the current row here.
        const detail = await getRecord(client, args.id)
        if (!detail) return notFoundResult(args.id)
        const existing = detail.record

        // Tags omitted → leave associations alone; provided (even []) →
        // resolve names to ids and replace via the data-layer diff (§14 R2).
        const tagIds =
          args.tags !== undefined
            ? await resolveTagNames(client, args.tags)
            : existing.tags.map(tag => tag.id)

        const updated = await updateRecord(client, {
          id: args.id,
          input: {
            type: args.type ?? existing.type,
            content: args.content ?? existing.content,
            meaning: args.meaning ?? existing.meaning,
            source: args.source !== undefined ? args.source : existing.source,
            notes: args.notes !== undefined ? args.notes : existing.notes,
            tagIds,
          },
        })
        // RLS-invisible or deleted between the read and the write.
        if (!updated) return notFoundResult(args.id)

        return textResult(formatRecord(updated, args.tags ?? existing.tags.map(tag => tag.name)))
      } catch (error) {
        return toErrorResult(error)
      }
    },
  )
}
