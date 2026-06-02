import { describe, it, expect } from 'vitest'
import { formatComments } from './comment-bar'
import type { FileComment } from '@renderer/context/file-preview-context'

describe('formatComments', () => {
  it('formats text selection comments with quoted context', () => {
    const comments: FileComment[] = [
      { id: '1', filePath: '/workspace/report.md', text: 'Please double-check this', selectedText: 'revenue grew by 15%' },
    ]
    const result = formatComments('/workspace/report.md', comments)
    expect(result).toContain('File feedback on `report.md`')
    expect(result).toContain('> "revenue grew by 15%"')
    expect(result).toContain('Please double-check this')
  })

  it('formats image annotation comments with coordinates', () => {
    const comments: FileComment[] = [
      { id: '1', filePath: '/workspace/screenshot.png', text: 'Button misaligned', x: 45.3, y: 72.8 },
    ]
    const result = formatComments('/workspace/screenshot.png', comments)
    expect(result).toContain('File feedback on `screenshot.png`')
    expect(result).toContain('At position (45%, 73%)')
    expect(result).toContain('Button misaligned')
  })

  it('formats multiple comments with blank line separators', () => {
    const comments: FileComment[] = [
      { id: '1', filePath: '/workspace/doc.md', text: 'Fix typo', selectedText: 'teh' },
      { id: '2', filePath: '/workspace/doc.md', text: 'Expand this section', selectedText: 'Conclusion' },
    ]
    const result = formatComments('/workspace/doc.md', comments)
    const lines = result.split('\n')
    // Should have a blank line between comments
    expect(lines.some(l => l === '')).toBe(true)
    expect(result).toContain('> "teh"')
    expect(result).toContain('> "Conclusion"')
  })

  it('formats plain comments without context', () => {
    const comments: FileComment[] = [
      { id: '1', filePath: '/workspace/file.txt', text: 'General feedback here' },
    ]
    const result = formatComments('/workspace/file.txt', comments)
    expect(result).toContain('General feedback here')
    expect(result).not.toContain('>')
    expect(result).not.toContain('At position')
  })

  it('handles mixed comment types', () => {
    const comments: FileComment[] = [
      { id: '1', filePath: '/workspace/doc.md', text: 'Wrong number', selectedText: '42%' },
      { id: '2', filePath: '/workspace/doc.md', text: 'Logo off-center', x: 50, y: 10 },
    ]
    const result = formatComments('/workspace/doc.md', comments)
    expect(result).toContain('> "42%"')
    expect(result).toContain('At position (50%, 10%)')
  })

  it('extracts filename from full path', () => {
    const result = formatComments('/workspace/deep/nested/file.pdf', [
      { id: '1', filePath: '/workspace/deep/nested/file.pdf', text: 'test' },
    ])
    expect(result).toContain('`file.pdf`')
  })
})
