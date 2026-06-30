import { describe, expect, it } from 'vitest'
import { getMcpServiceKey } from './mcp-server-card'

describe('getMcpServiceKey', () => {
  it('keeps localhost MCP servers on different ports separate', () => {
    expect(getMcpServiceKey('http://127.0.0.1:4101/mcp')).toBe('http://127.0.0.1:4101')
    expect(getMcpServiceKey('http://127.0.0.1:4102/mcp')).toBe('http://127.0.0.1:4102')
    expect(getMcpServiceKey('http://localhost:4103/mcp')).toBe('http://localhost:4103')
  })

  it('groups non-local custom MCP servers by hostname', () => {
    expect(getMcpServiceKey('https://mcp.example.com/one')).toBe('mcp.example.com')
    expect(getMcpServiceKey('https://mcp.example.com/two')).toBe('mcp.example.com')
  })
})
