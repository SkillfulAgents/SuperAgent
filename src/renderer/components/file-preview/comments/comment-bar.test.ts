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

  it('formats video comments with a timestamp and in-frame position', () => {
    const comments: FileComment[] = [
      { id: '1', filePath: '/workspace/clip.mp4', text: 'Cut this scene', timestamp: 75.4, x: 30.2, y: 60.9 },
    ]
    const result = formatComments('/workspace/clip.mp4', comments)
    expect(result).toContain('File feedback on `clip.mp4`')
    expect(result).toContain('At 1:15 at position (30%, 61%):')
    expect(result).toContain('Cut this scene')
  })

  it('formats a video comment with a timestamp but no in-frame position', () => {
    const comments: FileComment[] = [
      { id: '1', filePath: '/workspace/clip.mp4', text: 'Audio drops out', timestamp: 5 },
    ]
    const result = formatComments('/workspace/clip.mp4', comments)
    expect(result).toContain('At 0:05:')
    expect(result).not.toContain('position')
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

  it('formats cell comments with a Row:Col_Name identifier, column position and value', () => {
    const comments: FileComment[] = [
      {
        id: '1',
        filePath: '/workspace/contacts.csv',
        text: 'This email looks malformed',
        cell: { row: 3, col: 2, column: 'Email', value: 'john@@example' },
      },
    ]
    const result = formatComments('/workspace/contacts.csv', comments)
    expect(result).toContain('File feedback on `contacts.csv`')
    expect(result).toContain('At cell 3:Email (col 3, value: "john@@example"):')
    expect(result).toContain('This email looks malformed')
  })

  it('formats cell comments without a value', () => {
    const comments: FileComment[] = [
      {
        id: '1',
        filePath: '/workspace/data.csv',
        text: 'Missing value here',
        cell: { row: 5, col: 0, column: 'Name' },
      },
    ]
    const result = formatComments('/workspace/data.csv', comments)
    expect(result).toContain('At cell 5:Name (col 1):')
    expect(result).not.toContain('value:')
  })

  it('marks a comment on an empty cell as empty rather than dropping it', () => {
    const comments: FileComment[] = [
      {
        id: '1',
        filePath: '/workspace/data.csv',
        text: 'should not be blank',
        cell: { row: 2, col: 1, column: 'Email', value: '' },
      },
    ]
    const result = formatComments('/workspace/data.csv', comments)
    expect(result).toContain('At cell 2:Email (col 2, empty cell):')
  })

  it('escapes double quotes inside a cell value', () => {
    const comments: FileComment[] = [
      {
        id: '1',
        filePath: '/workspace/specs.csv',
        text: 'check this',
        cell: { row: 4, col: 0, column: 'Size', value: '27" monitor' },
      },
    ]
    const result = formatComments('/workspace/specs.csv', comments)
    expect(result).toContain('value: "27\\" monitor"')
  })

  it('disambiguates duplicate column names via the column position', () => {
    const comments: FileComment[] = [
      { id: '1', filePath: '/d.csv', text: 'a', cell: { row: 1, col: 1, column: 'Email', value: 'x' } },
      { id: '2', filePath: '/d.csv', text: 'b', cell: { row: 1, col: 2, column: 'Email', value: 'y' } },
    ]
    const result = formatComments('/d.csv', comments)
    expect(result).toContain('At cell 1:Email (col 2, value: "x"):')
    expect(result).toContain('At cell 1:Email (col 3, value: "y"):')
  })

  it('truncates very long cell values', () => {
    const long = 'x'.repeat(500)
    const comments: FileComment[] = [
      {
        id: '1',
        filePath: '/workspace/data.csv',
        text: 'too long',
        cell: { row: 1, col: 0, column: 'Blob', value: long },
      },
    ]
    const result = formatComments('/workspace/data.csv', comments)
    expect(result).toContain('…')
    expect(result).not.toContain(long)
  })

  it('extracts filename from full path', () => {
    const result = formatComments('/workspace/deep/nested/file.pdf', [
      { id: '1', filePath: '/workspace/deep/nested/file.pdf', text: 'test' },
    ])
    expect(result).toContain('`file.pdf`')
  })
})
