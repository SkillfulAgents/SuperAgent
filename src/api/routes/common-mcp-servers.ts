import { Hono } from 'hono'
import { getAllCommonMcpServers } from '@shared/lib/mcp/common-servers'
import { Authenticated } from '../middleware/auth'

const commonMcpServers = new Hono()

commonMcpServers.use('*', Authenticated())

// GET /api/common-mcp-servers - List all well-known MCP servers
commonMcpServers.get('/', async (c) => {
  const servers = getAllCommonMcpServers()
  return c.json({ servers })
})

export default commonMcpServers
