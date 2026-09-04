import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeWorkspacePath, workspaceFilePath } from './workspace-path'

function serverNormalize(rawPath: string): string | null {
  if (!rawPath.startsWith('/') || rawPath.includes('\0')) return null
  const normalizedPath = path.posix.normalize(rawPath)
  const normalized = normalizedPath === '/' ? normalizedPath : normalizedPath.replace(/\/+$/, '')
  if (normalized !== '/workspace' && !normalized.startsWith('/workspace/')) return null
  return normalized
}

describe('normalizeWorkspacePath', () => {
  it('matches the server folder rule, including /workspace itself', () => {
    const cases = [
      '/workspace/output/report.md',
      '/workspace/output/../report.md',
      '/workspace/./report.md',
      '/workspace/../secret.md',
      '/workspace/output/foo/../bar.md',
      '/workspace',
      '/workspace/',
      '/workspace/output/',
      '/secret.md',
      '/workspace/.env',
      '/workspace/report..md',
      './output/report.md',
      'output/../report.md',
      '',
    ]
    for (const input of cases) {
      expect(normalizeWorkspacePath(input), input).toBe(serverNormalize(input))
    }
  })

  it('rejects a NUL', () => {
    expect(normalizeWorkspacePath('/workspace/x\0.md')).toBeNull()
  })
})

describe('workspaceFilePath', () => {
  it('refuses the workspace root and keeps a file that stays inside', () => {
    expect(workspaceFilePath('/workspace')).toBeNull()
    expect(workspaceFilePath('/workspace/')).toBeNull()
    expect(workspaceFilePath('/workspace/report.md')).toBe('/workspace/report.md')
  })
})
