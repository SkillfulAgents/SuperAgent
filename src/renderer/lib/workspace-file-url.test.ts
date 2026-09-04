import { describe, expect, it, vi } from 'vitest'
import { encodeWorkspaceFilePath, getAgentFileApiPath, getAgentFileUrl, isSafeWorkspaceFilePath } from './workspace-file-url'

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

  describe('isSafeWorkspaceFilePath', () => {
    it.each([
      '/workspace/report.md',
      '/workspace/reports/q3/summary.md',
      '/workspace/a file with spaces.txt',
    ])('accepts %s', (path) => {
      expect(isSafeWorkspaceFilePath(path)).toBe(true)
    })

    // The encoder escapes; it cannot sanitise. `..` and `.` come through
    // encodeURIComponent unchanged, so they have to be refused rather than
    // escaped — which is what makes this the one check.
    it.each([
      ['a traversal', '/workspace/../etc/passwd'],
      ['a traversal mid-path', '/workspace/reports/../../etc/passwd'],
      ['a bare dot segment', '/workspace/./report.md'],
      ['an empty segment', '/workspace/reports//report.md'],
      ['a path outside the workspace', '/etc/passwd'],
      // /workspaceX is a sibling directory, not the workspace
      ['a directory that merely starts the same way', '/workspaceX/report.md'],
      ['the workspace root itself', '/workspace'],
      ['a NUL byte', '/workspace/report\u0000.md'],
    ])('refuses %s', (_why, path) => {
      expect(isSafeWorkspaceFilePath(path)).toBe(false)
    })
  })
})
