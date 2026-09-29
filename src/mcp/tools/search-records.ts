import type { McpServer } from '@modelcontextprotocol/server'
import { searchRecords } from '../../voc/records'
import { resolveTagNames } from '../../voc/tags'
import { toErrorResult } from '../shared/errors'
import { formatSearchResult, textResult } from '../shared/result'
import { SearchRecordsSchema } from '../shared/schemas'
import type { VocSessionFactory } from '../shared/session'

export function registerSearchRecords(server: McpServer, voc: VocSessionFactory): void {
  server.registerTool(
    'search_records',
    {
      title: 'Search vocabulary records',
      description:
        'Search the user\'s Voc records by substring (content or meaning), type, and tags. ' +
        'Tag filters are a union: records carrying ANY of the named tags match. ' +
        'Returns the matching records with their ids and tags, plus the total count — it says so explicitly when only a page of the total is shown. ' +
        'Does NOT return review scheduling; use get_record for that.',
      inputSchema: SearchRecordsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async args => {
      try {
        const { client } = await voc()
        const tagIds = args.tags.length > 0 ? await resolveTagNames(client, args.tags) : []
        const result = await searchRecords(client, {
          search: args.query,
          type: args.type,
          tagIds,
          sort: args.sort,
          page: args.page,
          pageSize: args.pageSize,
        })
        return textResult(formatSearchResult(result, result.records.length))
      } catch (error) {
        return toErrorResult(error)
      }
    },
  )
}
