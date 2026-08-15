import { describe, expect, it } from 'vitest'
import { encodeWorkspaceFilePath, getAgentFileApiPath, workspaceFilePathFromHref } from './workspace-file-url'

describe('workspaceFilePathFromHref', () => {
  it('returns a /workspace/ file path', () => {
    expect(workspaceFilePathFromHref('/workspace/output/report.md')).toBe('/workspace/output/report.md')
  })

  it('strips a hash fragment and a query string', () => {
    expect(workspaceFilePathFromHref('/workspace/output/report.md#section')).toBe(
      '/workspace/output/report.md',
    )
    expect(workspaceFilePathFromHref('/workspace/output/report.md?v=2')).toBe(
      '/workspace/output/report.md',
    )
  })

  it('decodes a percent-encoded filename once', () => {
    expect(workspaceFilePathFromHref('/workspace/my%20report.md')).toBe('/workspace/my report.md')
    expect(workspaceFilePathFromHref('/workspace/r%C3%A9sum%C3%A9.md')).toBe('/workspace/résumé.md')
    expect(workspaceFilePathFromHref('/workspace/Q3%20Report%20%231.xlsx')).toBe(
      '/workspace/Q3 Report #1.xlsx',
    )
  })

  it('rejects a malformed percent-escape', () => {
    expect(workspaceFilePathFromHref('/workspace/bad%zz.md')).toBeNull()
  })

  it('rejects web, in-app, relative, and scheme hrefs', () => {
    expect(workspaceFilePathFromHref('https://example.com/x.md')).toBeNull()
    expect(workspaceFilePathFromHref('/agents/foo')).toBeNull()
    expect(workspaceFilePathFromHref('report.md')).toBeNull()
    expect(workspaceFilePathFromHref('./notes.md')).toBeNull()
    expect(workspaceFilePathFromHref('file:///workspace/x.md')).toBeNull()
  })

  it('rejects empty, missing, and the bare /workspace/ prefix', () => {
    expect(workspaceFilePathFromHref('')).toBeNull()
    expect(workspaceFilePathFromHref(undefined)).toBeNull()
    expect(workspaceFilePathFromHref(null)).toBeNull()
    expect(workspaceFilePathFromHref('/workspace/')).toBeNull()
    expect(workspaceFilePathFromHref('/workspace')).toBeNull()
  })
})

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
})
