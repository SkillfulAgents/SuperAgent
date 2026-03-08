import { describe, it, expect } from 'vitest'
import { appendAttachedFiles, parseAttachedFiles } from './attached-files'

describe('appendAttachedFiles', () => {
  it('appends files to a message with content', () => {
    const result = appendAttachedFiles('Hello', ['/workspace/uploads/file.md'])
    expect(result).toBe('Hello\n\n[Attached files:]\n- /workspace/uploads/file.md')
  })

  it('creates a files-only message when content is empty', () => {
    const result = appendAttachedFiles('', ['/workspace/uploads/file.md'])
    expect(result).toBe('[Attached files:]\n- /workspace/uploads/file.md')
  })

  it('handles multiple files', () => {
    const result = appendAttachedFiles('Hi', ['/workspace/uploads/a.md', '/workspace/uploads/b.ts'])
    expect(result).toBe('Hi\n\n[Attached files:]\n- /workspace/uploads/a.md\n- /workspace/uploads/b.ts')
  })

  it('returns message unchanged when no files', () => {
    expect(appendAttachedFiles('Hello', [])).toBe('Hello')
  })
})

describe('parseAttachedFiles', () => {
  it('parses files from a message with content', () => {
    const text = 'Hello\n\n[Attached files:]\n- /workspace/uploads/file.md'
    const result = parseAttachedFiles(text)
    expect(result.cleanText).toBe('Hello')
    expect(result.attachedFiles).toEqual(['/workspace/uploads/file.md'])
  })

  it('parses files-only message', () => {
    const text = '[Attached files:]\n- /workspace/uploads/file.md'
    const result = parseAttachedFiles(text)
    expect(result.cleanText).toBe('')
    expect(result.attachedFiles).toEqual(['/workspace/uploads/file.md'])
  })

  it('parses multiple files', () => {
    const text = 'Hi\n\n[Attached files:]\n- /workspace/uploads/a.md\n- /workspace/uploads/b.ts'
    const result = parseAttachedFiles(text)
    expect(result.cleanText).toBe('Hi')
    expect(result.attachedFiles).toEqual(['/workspace/uploads/a.md', '/workspace/uploads/b.ts'])
  })

  it('handles blank line between marker and files', () => {
    const text = 'Hi\n\n[Attached files:]\n\n- /workspace/uploads/file.md'
    const result = parseAttachedFiles(text)
    expect(result.cleanText).toBe('Hi')
    expect(result.attachedFiles).toEqual(['/workspace/uploads/file.md'])
  })

  it('returns original text when no marker present', () => {
    const text = 'Just a normal message'
    const result = parseAttachedFiles(text)
    expect(result.cleanText).toBe('Just a normal message')
    expect(result.attachedFiles).toEqual([])
  })

  it('roundtrips with appendAttachedFiles', () => {
    const message = 'What is in this file?'
    const files = ['/workspace/uploads/1772936479165-agent-proxy-scope-policy.md', '/workspace/uploads/1772936479166-providers.ts']
    const encoded = appendAttachedFiles(message, files)
    const { cleanText, attachedFiles } = parseAttachedFiles(encoded)
    expect(cleanText).toBe(message)
    expect(attachedFiles).toEqual(files)
  })

  it('roundtrips with empty message', () => {
    const files = ['/workspace/uploads/file.md']
    const encoded = appendAttachedFiles('', files)
    const { cleanText, attachedFiles } = parseAttachedFiles(encoded)
    expect(cleanText).toBe('')
    expect(attachedFiles).toEqual(files)
  })
})
