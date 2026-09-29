import { describe, expect, it } from 'vitest'
import { createServer } from '../src/mcp/server'

describe('scaffold', () => {
  it('builds an McpServer with no tools registered yet', () => {
    const server = createServer()
    expect(server).toBeDefined()
  })
})
