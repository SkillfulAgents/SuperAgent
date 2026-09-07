import { describe, expect, it } from 'vitest'
import { bookmarkTarget, type Bookmark } from './bookmarks'

describe('bookmarkTarget', () => {
  it.each<[string, Bookmark, ReturnType<typeof bookmarkTarget>]>([
    ['a link', { name: 'Docs', link: 'https://example.com' }, { kind: 'link', url: 'https://example.com' }],
    ['a file', { name: 'Q3', file: '/workspace/q3.pdf' }, { kind: 'file', path: '/workspace/q3.pdf' }],
    ['a folder', { name: 'Out', folder: '/workspace/out' }, { kind: 'folder', path: '/workspace/out' }],
  ])('reads %s as one value', (_what, bookmark, expected) => {
    expect(bookmarkTarget(bookmark)).toEqual(expected)
  })

  // The union rules this out, but bookmarks arrive as JSON from the API, so the
  // row that draws one still needs somewhere to send a shape the server should
  // never have returned.
  it('returns null for a bookmark pointing at nothing', () => {
    expect(bookmarkTarget({ name: 'Empty' } as unknown as Bookmark)).toBeNull()
  })
})
