import { describe, expect, it, vi } from 'vitest'
import { describeWorkspaceFile } from './workspace-file'

vi.mock('@renderer/lib/env', () => ({ getApiBaseUrl: () => 'http://api.test' }))

describe('describeWorkspaceFile', () => {
  it('answers every question a file surface asks about one path', () => {
    expect(describeWorkspaceFile('/workspace/reports/q3.pdf', 'acme')).toEqual({
      path: '/workspace/reports/q3.pdf',
      agentSlug: 'acme',
      name: 'q3.pdf',
      relativePath: 'reports/q3.pdf',
      isFolder: false,
      category: 'document',
      preview: 'pdf',
      previewable: true,
      isImage: false,
      apiPath: '/api/agents/acme/files/reports/q3.pdf',
      downloadUrl: 'http://api.test/api/agents/acme/files/reports/q3.pdf',
      inlineUrl: 'http://api.test/api/agents/acme/files/reports/q3.pdf?inline=true',
    })
  })

  // A folder has no bytes: the file route answers 404 for one, so it gets no URL
  // rather than three that only fail when followed.
  it('gives a folder no URLs', () => {
    const folder = describeWorkspaceFile('/workspace/uploads/project/', 'acme')
    expect(folder).toMatchObject({
      name: 'project',
      relativePath: 'uploads/project',
      isFolder: true,
      preview: null,
      previewable: false,
      isImage: false,
      apiPath: null,
      downloadUrl: null,
      inlineUrl: null,
    })
  })

  it('marks a file the drawer can draw as a picture', () => {
    expect(describeWorkspaceFile('/workspace/shot.png', 'acme')).toMatchObject({
      category: 'image',
      preview: 'image',
      isImage: true,
    })
    // image/* to a browser, undisplayable to every renderer here
    expect(describeWorkspaceFile('/workspace/scan.tiff', 'acme')).toMatchObject({
      category: 'image',
      preview: null,
      previewable: false,
      isImage: false,
    })
  })

  it('reports a file the drawer cannot render but can still hand over', () => {
    expect(describeWorkspaceFile('/workspace/books.xlsx', 'acme')).toMatchObject({
      category: 'spreadsheet',
      previewable: false,
      downloadUrl: 'http://api.test/api/agents/acme/files/books.xlsx',
    })
  })

  // Only the preview drawer holds a cache-busting token, and it is the only
  // caller that passes one.
  it('folds the tab version into both URLs', () => {
    expect(describeWorkspaceFile('/workspace/a.png', 'acme', { version: 7 })).toMatchObject({
      downloadUrl: 'http://api.test/api/agents/acme/files/a.png?v=7',
      inlineUrl: 'http://api.test/api/agents/acme/files/a.png?inline=true&v=7',
    })
  })

  it('keeps the path it was handed as the identity, encoding only the URLs', () => {
    const file = describeWorkspaceFile('/workspace/Q3 & Q4/résumé.md', 'my agent')
    expect(file.path).toBe('/workspace/Q3 & Q4/résumé.md')
    expect(file.name).toBe('résumé.md')
    expect(file.apiPath).toBe('/api/agents/my%20agent/files/Q3%20%26%20Q4/r%C3%A9sum%C3%A9.md')
  })
})
