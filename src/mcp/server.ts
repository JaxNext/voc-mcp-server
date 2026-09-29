import { McpServer } from '@modelcontextprotocol/server'

/**
 * The MCP surface of the server. Stateless per the 2026-07-28 spec — no
 * `initialize` session, no `Mcp-Session-Id` (§3.1). `createMcpHandler` in
 * `src/index.ts` (Task 5) wires this to the streamable-HTTP transport.
 *
 * Task 1 registers no tools; the six tools of §6 arrive in Task 3.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: 'voc-mcp-server',
    version: '0.1.0',
  })

  return server
}
