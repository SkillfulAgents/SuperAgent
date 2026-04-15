import { describe, it, expect } from 'vitest'
import { BookmarksFileHook } from './bookmarks-hook'
import { resolveToolFilePath } from './file-hook'

const hook = new BookmarksFileHook()

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

describe('BookmarksFileHook.matches', () => {
  it('matches /workspace/bookmarks.json', () => {
    expect(hook.matches('/workspace/bookmarks.json')).toBe(true)
  })

  it('does not match bookmarks.json in a subdirectory', () => {
    expect(hook.matches('/workspace/data/bookmarks.json')).toBe(false)
  })

  it('does not match other JSON files', () => {
    expect(hook.matches('/workspace/config.json')).toBe(false)
  })

  it('does not match files with bookmarks in the directory name', () => {
    expect(hook.matches('/workspace/bookmarks/index.json')).toBe(false)
  })

  it('pattern returns the exact path', () => {
    expect(hook.pattern()).toBe('/workspace/bookmarks.json')
  })
})

// ---------------------------------------------------------------------------
// onRead
// ---------------------------------------------------------------------------

describe('BookmarksFileHook.onRead', () => {
  it('returns additional context with format hints', () => {
    const result = hook.onRead('/workspace/bookmarks.json')
    expect(result.additionalContext).toBeDefined()
    expect(result.additionalContext).toContain('bookmarks')
    expect(result.additionalContext).toContain('"link"')
    expect(result.additionalContext).toContain('"file"')
  })
})

// ---------------------------------------------------------------------------
// onWrite — valid content
// ---------------------------------------------------------------------------

describe('BookmarksFileHook.onWrite — valid', () => {
  it('accepts an empty array', () => {
    const result = hook.onWrite('/workspace/bookmarks.json', '[]')
    expect(result.error).toBeUndefined()
    expect(result.warning).toBeUndefined()
  })

  it('accepts a valid link bookmark', () => {
    const content = JSON.stringify([{ name: 'Google', link: 'https://google.com' }])
    const result = hook.onWrite('/workspace/bookmarks.json', content)
    expect(result.error).toBeUndefined()
    expect(result.warning).toBeUndefined()
  })

  it('accepts a valid file bookmark', () => {
    const content = JSON.stringify([{ name: 'Report', file: '/workspace/report.csv' }])
    const result = hook.onWrite('/workspace/bookmarks.json', content)
    expect(result.error).toBeUndefined()
    expect(result.warning).toBeUndefined()
  })

  it('accepts a mix of link and file bookmarks', () => {
    const content = JSON.stringify([
      { name: 'Sheet', link: 'https://docs.google.com/spreadsheets/d/abc' },
      { name: 'Log', file: '/workspace/output/log.txt' },
    ])
    const result = hook.onWrite('/workspace/bookmarks.json', content)
    expect(result.error).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// onWrite — invalid content
// ---------------------------------------------------------------------------

describe('BookmarksFileHook.onWrite — invalid', () => {
  it('rejects invalid JSON', () => {
    const result = hook.onWrite('/workspace/bookmarks.json', '{not json')
    expect(result.error).toContain('valid JSON')
  })

  it('rejects a bookmark with both link and file', () => {
    const content = JSON.stringify([{ name: 'Both', link: 'https://x.com', file: '/workspace/f.txt' }])
    const result = hook.onWrite('/workspace/bookmarks.json', content)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('exactly one')
  })

  it('rejects a bookmark with neither link nor file', () => {
    const content = JSON.stringify([{ name: 'Empty' }])
    const result = hook.onWrite('/workspace/bookmarks.json', content)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('exactly one')
  })

  it('rejects a bookmark with empty name', () => {
    const content = JSON.stringify([{ name: '', link: 'https://x.com' }])
    const result = hook.onWrite('/workspace/bookmarks.json', content)
    expect(result.error).toBeDefined()
  })

  it('rejects a non-https link', () => {
    const content = JSON.stringify([{ name: 'HTTP', link: 'http://insecure.com' }])
    const result = hook.onWrite('/workspace/bookmarks.json', content)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('https://')
  })

  it('rejects a non-URL link', () => {
    const content = JSON.stringify([{ name: 'Bad', link: 'not-a-url' }])
    const result = hook.onWrite('/workspace/bookmarks.json', content)
    expect(result.error).toBeDefined()
  })

  it('rejects non-array content', () => {
    const result = hook.onWrite('/workspace/bookmarks.json', '{"name":"x"}')
    expect(result.error).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// onWrite — warning for >5 bookmarks
// ---------------------------------------------------------------------------

describe('BookmarksFileHook.onWrite — warnings', () => {
  it('warns when there are more than 5 bookmarks', () => {
    const bookmarks = Array.from({ length: 6 }, (_, i) => ({
      name: `Bookmark ${i + 1}`,
      link: `https://example.com/${i}`,
    }))
    const result = hook.onWrite('/workspace/bookmarks.json', JSON.stringify(bookmarks))
    expect(result.error).toBeUndefined()
    expect(result.warning).toBeDefined()
    expect(result.warning).toContain('6 bookmarks')
  })

  it('does not warn for exactly 5 bookmarks', () => {
    const bookmarks = Array.from({ length: 5 }, (_, i) => ({
      name: `Bookmark ${i + 1}`,
      link: `https://example.com/${i}`,
    }))
    const result = hook.onWrite('/workspace/bookmarks.json', JSON.stringify(bookmarks))
    expect(result.error).toBeUndefined()
    expect(result.warning).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// onEdit — delegates to same validation
// ---------------------------------------------------------------------------

describe('BookmarksFileHook.onEdit', () => {
  it('validates content after edit', () => {
    const result = hook.onEdit('/workspace/bookmarks.json', '{bad json')
    expect(result.error).toContain('valid JSON')
  })

  it('accepts valid content after edit', () => {
    const content = JSON.stringify([{ name: 'OK', link: 'https://ok.com' }])
    const result = hook.onEdit('/workspace/bookmarks.json', content)
    expect(result.error).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveToolFilePath
// ---------------------------------------------------------------------------

describe('resolveToolFilePath', () => {
  it('returns absolute path as-is', () => {
    const result = resolveToolFilePath({ file_path: '/workspace/bookmarks.json' }, '/workspace')
    expect(result).toBe('/workspace/bookmarks.json')
  })

  it('resolves relative path against working directory', () => {
    const result = resolveToolFilePath({ file_path: 'bookmarks.json' }, '/workspace')
    expect(result).toContain('workspace')
    expect(result).toMatch(/bookmarks\.json$/)
  })

  it('returns null when file_path is missing', () => {
    const result = resolveToolFilePath({}, '/workspace')
    expect(result).toBeNull()
  })
})
