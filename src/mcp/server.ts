import { McpServer } from '@modelcontextprotocol/server'
import { registerCreateRecord } from './tools/create-record'
import { registerDeleteRecord } from './tools/delete-record'
import { registerGetRecord } from './tools/get-record'
import { registerListTags } from './tools/list-tags'
import { registerSearchRecords } from './tools/search-records'
import { registerUpdateRecord } from './tools/update-record'
import type { VocSessionFactory } from './shared/session'

/**
 * The MCP surface of the server: exactly the six tools of §6, wired to the
 * Task 2 data layer. Stateless per the 2026-07-28 spec — no `initialize`
 * session, no `Mcp-Session-Id` (§3.1). `createMcpHandler` in `src/index.ts`
 * calls this factory once per HTTP request.
 *
 * Voc access is injected via `voc` so the tools stay free of OAuth coupling:
 * Task 5 builds the session from `authInfo` + KV, tests stub it. No tool
 * accepts a `user_id` — identity always comes from this session (§8).
 */
export function createServer(voc: VocSessionFactory): McpServer {
  const server = new McpServer({
    name: 'voc-mcp-server',
    version: '0.1.0',
  })

  registerCreateRecord(server, voc)
  registerSearchRecords(server, voc)
  registerGetRecord(server, voc)
  registerUpdateRecord(server, voc)
  registerDeleteRecord(server, voc)
  registerListTags(server, voc)

  return server
}
