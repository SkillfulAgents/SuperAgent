import { describe, expect, it } from 'vitest'
import { withPreviewVersion } from './file-preview-url'

describe('preview source URLs', () => {
  it.each([
    ['/api/files/report.pdf', '/api/files/report.pdf?v=42'],
    ['/api/files/report.pdf#page=3', '/api/files/report.pdf?v=42#page=3'],
    ['/api/files?path=Reports%2FQ1%20%23.pdf&inline=true&v=old#page=3', '/api/files?path=Reports%2FQ1+%23.pdf&inline=true&v=42#page=3'],
    ['https://files.test/report.pdf?v=old', 'https://files.test/report.pdf?v=42'],
    ['//files.test/report.pdf?inline=true', '//files.test/report.pdf?inline=true&v=42'],
  ])('versions %s without losing its path, parameters or fragment', (url, expected) => {
    expect(withPreviewVersion(url, 42)).toBe(expected)
  })

  it.each([
    'data:text/plain,report?value=1#contents',
    'blob:https://app.test/opaque-file-id',
  ])('leaves fixed bytes at %s unchanged', url => {
    expect(withPreviewVersion(url, 42)).toBe(url)
  })

  it('leaves an unversioned URL alone', () => {
    expect(withPreviewVersion('/api/files?path=report.pdf', 0)).toBe('/api/files?path=report.pdf')
  })
})
