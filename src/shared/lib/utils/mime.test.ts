import { describe, it, expect } from 'vitest'
import { guessMimeType, getFileExtension } from './mime'

describe('guessMimeType', () => {
  it('returns correct MIME for common extensions', () => {
    expect(guessMimeType('report.pdf')).toBe('application/pdf')
    expect(guessMimeType('photo.png')).toBe('image/png')
    expect(guessMimeType('data.json')).toBe('application/json')
    expect(guessMimeType('readme.md')).toBe('text/markdown')
    expect(guessMimeType('style.css')).toBe('text/css')
    expect(guessMimeType('page.html')).toBe('text/html')
    expect(guessMimeType('image.jpg')).toBe('image/jpeg')
    expect(guessMimeType('image.jpeg')).toBe('image/jpeg')
    expect(guessMimeType('icon.svg')).toBe('image/svg+xml')
    expect(guessMimeType('notes.txt')).toBe('text/plain')
    expect(guessMimeType('doc.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  })

  it('is case-insensitive', () => {
    expect(guessMimeType('FILE.PDF')).toBe('application/pdf')
    expect(guessMimeType('Image.PNG')).toBe('image/png')
  })

  it('returns octet-stream for unknown extensions', () => {
    expect(guessMimeType('file.xyz')).toBe('application/octet-stream')
    expect(guessMimeType('archive.tar.gz')).toBe('application/octet-stream')
  })

  it('returns octet-stream for files without extension', () => {
    expect(guessMimeType('Makefile')).toBe('application/octet-stream')
    expect(guessMimeType('LICENSE')).toBe('application/octet-stream')
  })

  it('handles paths with directories', () => {
    expect(guessMimeType('/workspace/output/report.pdf')).toBe('application/pdf')
    expect(guessMimeType('src/index.ts')).toBe('text/typescript')
  })
})

describe('getFileExtension', () => {
  it('returns the extension without dot', () => {
    expect(getFileExtension('file.txt')).toBe('txt')
    expect(getFileExtension('report.pdf')).toBe('pdf')
  })

  it('returns lowercase', () => {
    expect(getFileExtension('FILE.PDF')).toBe('pdf')
  })

  it('returns last extension for multiple dots', () => {
    expect(getFileExtension('archive.tar.gz')).toBe('gz')
  })

  it('returns empty string for no extension', () => {
    expect(getFileExtension('Makefile')).toBe('makefile')
  })
})
