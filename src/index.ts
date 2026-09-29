import type { Env } from './types/env'

/**
 * Task 1: minimal worker — proves the scaffold boots. The §8 shape (OAuthProvider
 * wrapping `createMcpHandler(createServer)`) is wired in Task 5 of
 * docs/implementation-plan.md.
 */
export default {
  async fetch(request, _env: Env, _ctx): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/mcp') {
      return Response.json(
        { error: 'not_wired_yet', detail: 'OAuth + MCP transport arrive in Task 5 (§8)' },
        { status: 501 },
      )
    }

    return Response.json({ ok: true, service: 'voc-mcp-server' })
  },
} satisfies ExportedHandler<Env>
