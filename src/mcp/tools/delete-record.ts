import type { McpServer } from '@modelcontextprotocol/server'
import { deleteRecord } from '../../voc/records'
import { notFoundResult, toErrorResult } from '../shared/errors'
import { textResult } from '../shared/result'
import { RecordIdInputSchema } from '../shared/schemas'
import type { VocSessionFactory } from '../shared/session'

export function registerDeleteRecord(server: McpServer, voc: VocSessionFactory): void {
  server.registerTool(
    'delete_record',
    {
      title: 'Delete vocabulary record',
      description:
        'Permanently delete a Voc record by id. DESTRUCTIVE and unrecoverable: the record, its tag ' +
        'associations, its review state and its entire review history are destroyed — they cannot be restored. ' +
        'Returns a one-line confirmation naming the deleted content. Does NOT delete tags themselves, only the links.',
      inputSchema: RecordIdInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async args => {
      try {
        const { client } = await voc()
        const deleted = await deleteRecord(client, args.id)
        if (!deleted) return notFoundResult(args.id)
        return textResult(
          `Deleted ${deleted.type} "${deleted.content}" (id: ${deleted.id}). ` +
          'Its review history was permanently destroyed and cannot be recovered.',
        )
      } catch (error) {
        return toErrorResult(error)
      }
    },
  )
}
