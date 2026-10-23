import { describe, expect, it } from 'vitest'
import type { FolderEntry } from '@renderer/hooks/use-folder-entries'
import { driveTree, foldersToList, splitFrontPages, withoutTeamRecord, type DriveListing } from './team-brain-drive'

const file = (path: string, mtimeMs?: number): FolderEntry => ({ name: path.split('/').at(-1)!, path, type: 'file', mtimeMs })
const dir = (path: string): FolderEntry => ({ name: path.split('/').at(-1)!, path, type: 'directory' })
const files = (folder: string, n: number) => Array.from({ length: n }, (_, i) => file(`${folder}/p${i}.md`))

describe('foldersToList', () => {
  it('starts at the top', () => {
    expect(foldersToList(new Map(), new Set())).toEqual([''])
  })

  it('lists level by level and stops after the first level past the budget', () => {
    const listed: DriveListing = new Map([
      ['', [dir('a'), dir('b')]],
      ['a', [dir('a/x'), ...files('a', 6)]],
      ['b', [dir('b/y'), ...files('b', 6)]],
    ])
    expect(foldersToList(listed, new Set(), 10)).toEqual([])
    expect(foldersToList(listed, new Set(), 20)).toEqual(['a/x', 'b/y'])
  })

  it('does not go into a folder too big for the budget, nor let it stop the others', () => {
    const listed: DriveListing = new Map([['', [dir('a'), dir('huge')]], ['a', [dir('a/x')]], ['huge', files('huge', 50)]])
    expect(foldersToList(listed, new Set(), 20)).toEqual(['a/x'])
  })

  it('lists an opened folder on half the budget', () => {
    const listed: DriveListing = new Map([['', [dir('a')]], ['a', [dir('a/x'), dir('a/y')]]])
    expect(foldersToList(listed, new Set(['a/x']), 1)).toEqual(['a/x'])
  })
})

describe('driveTree', () => {
  it('builds nodes from what is listed, skipping hidden entries, with page ages', () => {
    const now = 10 * 60_000
    const listed: DriveListing = new Map([['', [dir('a'), dir('b'), file('README.md', now - 3 * 60_000), file('.claim')]], ['a', [file('a/p.md')]]])
    expect(driveTree(listed, now)).toEqual([
      { id: 'a', name: 'a', kind: 'folder', sources: [], children: [{ id: 'a/p.md', name: 'p.md', kind: 'file', sources: [], updatedMinutesAgo: undefined }] },
      { id: 'b', name: 'b', kind: 'folder', sources: [], children: undefined },
      { id: 'README.md', name: 'README.md', kind: 'file', sources: [], updatedMinutesAgo: 3 },
    ])
  })
})

describe('withoutTeamRecord', () => {
  it('drops the team record from the top, so its folders are neither shown nor listed', () => {
    const listed: DriveListing = new Map([['', [dir('_brain'), dir('company'), file('INDEX.md'), file('README.md')]]])
    const hidden = withoutTeamRecord(listed)
    expect(hidden.get('')?.map((entry) => entry.path)).toEqual(['company', 'README.md'])
    expect(foldersToList(hidden, new Set())).toEqual(['company'])
  })
})

describe('splitFrontPages', () => {
  it('takes the top README and INDEX out of the tree for its middle, and only the top ones', () => {
    const tree = driveTree(new Map([['', [dir('company'), file('INDEX.md'), file('README.md')]], ['company', [file('company/README.md')]]]), 0)
    const { front, index, rest } = splitFrontPages(tree)
    expect([front?.id, index?.id]).toEqual(['README.md', 'INDEX.md'])
    expect(rest.map((node) => node.id)).toEqual(['company'])
    expect(splitFrontPages(rest)).toMatchObject({ front: undefined, index: undefined })
  })
})
