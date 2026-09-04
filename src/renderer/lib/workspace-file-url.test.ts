import { describe, expect, it } from 'vitest'
import { encodeWorkspaceFilePath, fallbackWorkspaceFilePath, getAgentFileApiPath, workspaceFilePathFromFileUrl, workspaceFilePathFromHref, workspaceFilePathFromRelativeHref } from './workspace-file-url'

describe('workspaceFilePathFromHref', () => {
  it('returns a /workspace/ file path', () => {
    expect(workspaceFilePathFromHref('/workspace/output/report.md')).toBe('/workspace/output/report.md')
  })

  it('keeps a literal hash or query in the filename', () => {
    expect(workspaceFilePathFromHref('/workspace/output/Issue #12 notes.md')).toBe(
      '/workspace/output/Issue #12 notes.md',
    )
    expect(workspaceFilePathFromHref('/workspace/output/report.md?v=2')).toBe(
      '/workspace/output/report.md?v=2',
    )
  })

  it('collapses dots in the full destination, including after a query mark', () => {
    expect(workspaceFilePathFromHref('/workspace/output/report.md?/../gone')).toBe(
      '/workspace/output/gone',
    )
  })

  it('decodes a percent-encoded filename once', () => {
    expect(workspaceFilePathFromHref('/workspace/my%20report.md')).toBe('/workspace/my report.md')
    expect(workspaceFilePathFromHref('/workspace/r%C3%A9sum%C3%A9.md')).toBe('/workspace/résumé.md')
    expect(workspaceFilePathFromHref('/workspace/Q3%20Report%20%231.xlsx')).toBe(
      '/workspace/Q3 Report #1.xlsx',
    )
  })

  it('keeps the raw name when a percent-escape is malformed', () => {
    expect(workspaceFilePathFromHref('/workspace/90%done.md')).toBe('/workspace/90%done.md')
    expect(workspaceFilePathFromHref('/workspace/bad%zz.md')).toBe('/workspace/bad%zz.md')
  })

  it('collapses dots that stay in the workspace', () => {
    expect(workspaceFilePathFromHref('/workspace/output/../report.md')).toBe('/workspace/report.md')
    expect(workspaceFilePathFromHref('/workspace/./report.md')).toBe('/workspace/report.md')
    expect(workspaceFilePathFromHref('/workspace/reports%2F..%2Fsecret.md')).toBe('/workspace/secret.md')
  })

  it('refuses a path that leaves /workspace after collapse', () => {
    const unsafeHrefs = [
      '/workspace/../secret.md',
      '/workspace/reports/../../secret.md',
      '/workspace/%2e%2e/secret.md',
      '/workspace/%2E./secret.md',
      '/workspace/.%2e/secret.md',
      '/workspace/../../../../../../api/agents/local-agent/files/private.md',
    ]

    for (const href of unsafeHrefs) {
      expect(workspaceFilePathFromHref(href), href).toBeNull()
    }
  })

  it('keeps dotted names and decodes only once', () => {
    expect(workspaceFilePathFromHref('/workspace/.env')).toBe('/workspace/.env')
    expect(workspaceFilePathFromHref('/workspace/report..md')).toBe('/workspace/report..md')
    expect(workspaceFilePathFromHref('/workspace/v1.2/file.md')).toBe('/workspace/v1.2/file.md')
    expect(workspaceFilePathFromHref('/workspace/.../notes.md')).toBe('/workspace/.../notes.md')
    expect(workspaceFilePathFromHref('/workspace/%252e%252e/notes.md')).toBe(
      '/workspace/%2e%2e/notes.md',
    )
  })

  it('rejects web, in-app, relative, and file: hrefs', () => {
    expect(workspaceFilePathFromHref('https://example.com/x.md')).toBeNull()
    expect(workspaceFilePathFromHref('/agents/foo')).toBeNull()
    expect(workspaceFilePathFromHref('report.md')).toBeNull()
    expect(workspaceFilePathFromHref('./notes.md')).toBeNull()
    expect(workspaceFilePathFromHref('file:///workspace/output/report.md')).toBeNull()
    expect(workspaceFilePathFromHref('file:///etc/passwd')).toBeNull()
    expect(workspaceFilePathFromHref('file:///workspace/../secret.md')).toBeNull()
  })

  it('rejects empty, missing, and the bare /workspace/ prefix', () => {
    expect(workspaceFilePathFromHref('')).toBeNull()
    expect(workspaceFilePathFromHref(undefined)).toBeNull()
    expect(workspaceFilePathFromHref(null)).toBeNull()
    expect(workspaceFilePathFromHref('/workspace/')).toBeNull()
    expect(workspaceFilePathFromHref('/workspace')).toBeNull()
  })
})

describe('workspaceFilePathFromRelativeHref', () => {
  const fromReport = '/workspace/output/report.md'

  it('joins a relative name to the open file folder', () => {
    expect(workspaceFilePathFromRelativeHref('notes.md', fromReport)).toBe(
      '/workspace/output/notes.md',
    )
    expect(workspaceFilePathFromRelativeHref('./notes.md', fromReport)).toBe(
      '/workspace/output/notes.md',
    )
    expect(workspaceFilePathFromRelativeHref('../readme.md', fromReport)).toBe(
      '/workspace/readme.md',
    )
  })

  it('keeps an absolute workspace href unchanged', () => {
    expect(workspaceFilePathFromRelativeHref('/workspace/other/a.md', fromReport)).toBe(
      '/workspace/other/a.md',
    )
  })

  it('refuses a relative path that leaves /workspace', () => {
    expect(workspaceFilePathFromRelativeHref('../../secret.md', fromReport)).toBeNull()
  })

  it('leaves fragments, schemes, and in-app routes unresolved', () => {
    expect(workspaceFilePathFromRelativeHref('#s2', fromReport)).toBeNull()
    expect(workspaceFilePathFromRelativeHref('https://example.com/x.md', fromReport)).toBeNull()
    expect(workspaceFilePathFromRelativeHref('/agents/foo', fromReport)).toBeNull()
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

  it('normalizes delivered dotted paths that stay in the workspace', () => {
    expect(getAgentFileApiPath('agent-1', './output/report.md')).toBe(
      '/api/agents/agent-1/files/output/report.md',
    )
    expect(getAgentFileApiPath('agent-1', 'output/../report.md')).toBe(
      '/api/agents/agent-1/files/report.md',
    )
    expect(getAgentFileApiPath('agent-1', '/workspace/output/../report.md')).toBe(
      '/api/agents/agent-1/files/report.md',
    )
  })

  it('rejects a path that escapes /workspace/ after normalize', () => {
    expect(getAgentFileApiPath('agent-1', '/workspace/../secret.md')).toBeNull()
    expect(getAgentFileApiPath('agent-1', 'reports/../../secret.md')).toBeNull()
    expect(getAgentFileApiPath('agent-1', '/secret.md')).toBeNull()
  })

  it('offers a stripped fallback only when the path still has a query or hash', () => {
    expect(fallbackWorkspaceFilePath('/workspace/output/report.md#results')).toBe(
      '/workspace/output/report.md',
    )
    expect(fallbackWorkspaceFilePath('/workspace/output/report.md?v=2')).toBe(
      '/workspace/output/report.md',
    )
    expect(fallbackWorkspaceFilePath('/workspace/output/report.md')).toBeNull()
    expect(fallbackWorkspaceFilePath('/workspace/output/Issue #12 notes.md')).toBe(
      '/workspace/output/Issue ',
    )
  })

  it('accepts FILE: the same way as file:', () => {
    expect(workspaceFilePathFromFileUrl('FILE:///workspace/output/report.md')).toBe(
      '/workspace/output/report.md',
    )
    expect(workspaceFilePathFromFileUrl('file:///workspace/output/report.md')).toBe(
      '/workspace/output/report.md',
    )
  })

  it('safely re-encodes a literal percent-encoded filename', () => {
    expect(getAgentFileApiPath('agent-1', '/workspace/%2e%2e/notes.md')).toBe(
      '/api/agents/agent-1/files/%252e%252e/notes.md',
    )
  })
})
