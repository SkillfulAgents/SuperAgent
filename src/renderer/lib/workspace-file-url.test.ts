import { describe, expect, it, vi } from 'vitest'
import { encodeWorkspaceFilePath, getAgentFileApiPath, getAgentFileUrl } from './workspace-file-url'

vi.mock('@renderer/lib/env', () => ({ getApiBaseUrl: () => 'http://api.test' }))

describe('workspace file URLs', () => {
  it('encodes every path segment without encoding separators', () => {
    expect(encodeWorkspaceFilePath('/workspace/Reports & 2026/résumé #1?.md')).toBe(
      'Reports%20%26%202026/r%C3%A9sum%C3%A9%20%231%3F.md',
    )
  })

  it('encodes the agent slug', () => {
    expect(getAgentFileApiPath('Agent #1', '/workspace/report.md')).toBe(
      '/api/agents/Agent%20%231/files/report.md',
    )
  })

  describe('getAgentFileUrl', () => {
    it('builds a bare download URL by default', () => {
      expect(getAgentFileUrl('a', '/workspace/output/report.md')).toBe(
        'http://api.test/api/agents/a/files/output/report.md',
      )
    })

    it('asks for inline bytes when told to', () => {
      expect(getAgentFileUrl('a', '/workspace/report.md', { inline: true })).toBe(
        'http://api.test/api/agents/a/files/report.md?inline=true',
      )
    })

    // Version 0 means the file has never been redelivered, so there is nothing
    // to bust and no reason to carry a parameter the server ignores.
    it('omits the cache buster at version 0 and carries it above', () => {
      expect(getAgentFileUrl('a', '/workspace/report.md', { version: 0 })).toBe(
        'http://api.test/api/agents/a/files/report.md',
      )
      expect(getAgentFileUrl('a', '/workspace/report.md', { inline: true, version: 3 })).toBe(
        'http://api.test/api/agents/a/files/report.md?inline=true&v=3',
      )
    })
  })
})
