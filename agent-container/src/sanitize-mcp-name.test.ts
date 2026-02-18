import { describe, it, expect } from 'vitest'
import { sanitizeMcpName, RESERVED_MCP_NAMES } from './sanitize-mcp-name'

describe('sanitizeMcpName', () => {
  it('lowercases the name', () => {
    expect(sanitizeMcpName('MyServer')).toBe('myserver')
  })

  it('replaces non-alphanumeric characters with underscores', () => {
    expect(sanitizeMcpName('my-mcp-server')).toBe('my_mcp_server')
  })

  it('replaces spaces with underscores', () => {
    expect(sanitizeMcpName('My MCP Server')).toBe('my_mcp_server')
  })

  it('replaces dots and slashes with underscores', () => {
    expect(sanitizeMcpName('api.example.com/v1')).toBe('api_example_com_v1')
  })

  it('handles already clean names', () => {
    expect(sanitizeMcpName('weather')).toBe('weather')
  })

  it('handles names with numbers', () => {
    expect(sanitizeMcpName('api2test')).toBe('api2test')
  })

  it('prefixes reserved name "user_input" with remote_', () => {
    expect(sanitizeMcpName('user_input')).toBe('remote_user_input')
  })

  it('prefixes reserved name "browser" with remote_', () => {
    expect(sanitizeMcpName('browser')).toBe('remote_browser')
  })

  it('prefixes reserved name "dashboards" with remote_', () => {
    expect(sanitizeMcpName('dashboards')).toBe('remote_dashboards')
  })

  it('prefixes names that sanitize to a reserved name', () => {
    // "User-Input" sanitizes to "user_input" which is reserved
    expect(sanitizeMcpName('User-Input')).toBe('remote_user_input')
    // "Browser!" sanitizes to "browser_" which is NOT reserved
    expect(sanitizeMcpName('Browser!')).toBe('browser_')
    // "Browser" sanitizes to "browser" which IS reserved
    expect(sanitizeMcpName('Browser')).toBe('remote_browser')
  })

  it('does not prefix names that merely contain a reserved name', () => {
    expect(sanitizeMcpName('my_browser_tool')).toBe('my_browser_tool')
    expect(sanitizeMcpName('user_input_extra')).toBe('user_input_extra')
  })

  it('handles empty string', () => {
    expect(sanitizeMcpName('')).toBe('')
  })

  it('RESERVED_MCP_NAMES contains expected entries', () => {
    expect(RESERVED_MCP_NAMES.has('user_input')).toBe(true)
    expect(RESERVED_MCP_NAMES.has('browser')).toBe(true)
    expect(RESERVED_MCP_NAMES.has('dashboards')).toBe(true)
    expect(RESERVED_MCP_NAMES.size).toBe(3)
  })
})
