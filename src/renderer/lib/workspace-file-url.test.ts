import { describe, expect, it, vi } from 'vitest'
import { encodeWorkspaceFilePath, getAgentFileApiPath, getAgentFileUrl, isSafeWorkspaceFilePath, resolveAgentFilePath } from './workspace-file-url'

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

    it('carries a string token, such as a delivery id, and omits an empty one', () => {
      expect(getAgentFileUrl('a', '/workspace/chart.png', { inline: true, version: 'toolu_01' })).toBe(
        'http://api.test/api/agents/a/files/chart.png?inline=true&v=toolu_01',
      )
      expect(getAgentFileUrl('a', '/workspace/chart.png', { version: '' })).toBe(
        'http://api.test/api/agents/a/files/chart.png',
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

  describe('resolveAgentFilePath', () => {
    it.each([
      ['an absolute path', '/workspace/out/a.md', undefined, '/workspace/out/a.md'],
      ['its file: form', 'file:///workspace/out/a.md', undefined, '/workspace/out/a.md'],
      ['an encoded name, decoded once', '/workspace/out/Q3%20report.md', undefined, '/workspace/out/Q3 report.md'],
      ['a query and heading, dropped', '/workspace/out/a.md?x#results', undefined, '/workspace/out/a.md'],
      ['a stray %, kept raw in its own segment', '/workspace/90%done/Q3%20report.md', undefined, '/workspace/90%done/Q3 report.md'],
      ['a path relative to its folder', 'shots/a.png', '/workspace/blog', '/workspace/blog/shots/a.png'],
      ['a dot segment that stays inside', '../a.png', '/workspace/blog', '/workspace/a.png'],
      ['a folder with a literal %', 'a.png', '/workspace/90%done', '/workspace/90%done/a.png'],
      ['a drive path', '/mounts/Drive/a.md', undefined, '/mounts/Drive/a.md'],
      ['a path relative to a drive file', 'a.png', '/mounts/Drive/docs', '/mounts/Drive/docs/a.png'],
      ['a folder, keeping its slash', 'shots/', '/workspace/blog', '/workspace/blog/shots/'],
      ['an absolute folder', '/workspace/out/', undefined, '/workspace/out/'],
      ['a localhost file: URL, which names this machine', 'file://localhost/workspace/a.md', undefined, '/workspace/a.md'],
    ])('resolves %s', (_, reference, folder, expected) => {
      expect(resolveAgentFilePath(reference, folder)).toBe(expected)
    })

    it.each([
      ['a relative path with no folder', 'out/a.md', undefined],
      ['a scheme-less web address with no folder', 'github.com/acme/repo', undefined],
      ['a path that leaves the workspace', '../../etc/passwd', '/workspace/blog'],
      ['an encoded traversal', '/workspace/out/..%2F..%2Fetc/passwd', undefined],
      ['an escaped slash at the end', '/workspace/a%2F', undefined],
      ['an encoded dot traversal', '/workspace/%2e%2e/etc/passwd', undefined],
      ['a backslash traversal', '/workspace/a\\..\\..\\etc/passwd', undefined],
      ['an escaped slash inside a name', 'a%2Fb.md', '/workspace/blog'],
      ['a host', '//localhost/workspace/a.md', undefined],
      ['a host, even with a folder', '//localhost/workspace/a.md', '/workspace/blog'],
      ['a web URL', 'https://example.com/a.md', undefined],
      ['an app page', '/agents/a/sessions/s', undefined],
      ['a heading only', '#results', '/workspace/blog'],
      ['the workspace root', '/workspace/', undefined],
      ['an empty reference', '', '/workspace/blog'],
      ['a drive root', '/mounts/Drive', undefined],
      ['a display path from another source', 'a.md', '/Team Brain/policies'],
    ])('refuses %s', (_, reference, folder) => {
      expect(resolveAgentFilePath(reference, folder)).toBeNull()
    })
  })
})
