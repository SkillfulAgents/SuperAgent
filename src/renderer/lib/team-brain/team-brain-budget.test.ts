import { describe, expect, it } from 'vitest'
import { revealDrive } from './team-brain-budget'
import type { TeamBrainNode } from './team-brain-structure'

const page = (id: string, ago = 0): TeamBrainNode => ({ id, name: `${id}.md`, kind: 'file', sources: [], updatedMinutesAgo: ago })
const folder = (id: string, children: TeamBrainNode[]): TeamBrainNode => ({ id, name: id, kind: 'folder', sources: [], children })
const pages = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => page(`${prefix}${i}`, i))

describe('revealDrive', () => {
  it('shows a drive that fits whole', () => {
    const drive = [folder('a', [folder('a1', pages('a1-', 5))]), folder('b', pages('b', 5))]
    expect(revealDrive(drive, new Set(), 20)).toEqual(drive)
  })

  it('stops at the deepest whole level that fits, folding folders below it into counts', () => {
    const sub = (id: string) => [folder(`${id}1`, pages(id, 5)), folder(`${id}2`, pages(id, 5))]
    const shown = revealDrive([folder('a', sub('a')), folder('b', sub('b'))], new Set(), 3)
    expect(shown.map((n) => [n.children, n.hidden])).toEqual([[[], 2], [[], 2]])
  })

  it('fills the ring with each folder\'s newest pages and a "+N more" that opens it, when the pages do not all fit', () => {
    const [a, b] = revealDrive([folder('a', pages('a', 15)), folder('b', pages('b', 15))], new Set(), 20)
    expect(a.children!.map((n) => n.id)).toEqual([...pages('a', 9).map((n) => n.id), 'a//more'])
    expect(b.children![9]).toMatchObject({ name: '+6 more', expands: 'b' })
    // The top level's own "+N more" is not a folder called root's.
    expect(revealDrive(pages('t', 30), new Set(), 20).at(-1)?.id).toBe('//more')
  })

  it('keeps a folder too big for the budget folded without holding the others back', () => {
    const drive = [folder('a', pages('a', 5)), folder('huge', pages('h', 50))]
    const [a, huge] = revealDrive(drive, new Set(), 20)
    expect(a.children).toHaveLength(5)
    expect(huge).toMatchObject({ children: [], hidden: 50 })
  })

  it('opens an expanded folder, on half the budget, to its newest pages and lists the rest in one more page', () => {
    const [huge] = revealDrive([folder('huge', pages('h', 50))], new Set(['huge']), 20)
    expect(huge.children).toHaveLength(10)
    expect(huge.children!.slice(0, 9).map((n) => n.id)).toEqual(pages('h', 9).map((n) => n.id))
    expect(huge.children![9]).toMatchObject({ name: '+41 more', kind: 'file', more: expect.arrayContaining(['h49.md']) })
  })
})
