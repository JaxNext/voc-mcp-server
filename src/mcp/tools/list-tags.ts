import type { McpServer } from '@modelcontextprotocol/server'
import { listTags } from '../../voc/tags'
import { toErrorResult } from '../shared/errors'
import { formatTags, textResult } from '../shared/result'
import type { VocSessionFactory } from '../shared/session'

export function registerListTags(server: McpServer, voc: VocSessionFactory): void {
  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description:
        'List the tag names available in Voc: the predefined tags plus the user\'s own custom tags. ' +
        'Call this before write tools to discover valid tag names — unknown names are rejected, not created. ' +
        'Returns names only, not usage counts, and does NOT create tags.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      try {
        const { client } = await voc()
        return textResult(formatTags(await listTags(client)))
      } catch (error) {
        return toErrorResult(error)
      }
    },
  )
}
