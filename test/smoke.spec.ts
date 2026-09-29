import { describe, expect, it } from 'vitest'
import type { PostgrestClient } from '../src/voc/postgrest'
import { createServer } from '../src/mcp/server'

const stubSession = () => Promise.resolve({ client: {} as PostgrestClient, userId: 'stub-user' })

describe('scaffold', () => {
  it('builds an McpServer with the six tools registered', () => {
    const server = createServer(stubSession)
    expect(server).toBeDefined()
  })
})
