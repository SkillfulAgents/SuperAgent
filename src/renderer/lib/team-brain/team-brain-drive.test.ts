import { describe, expect, it } from 'vitest'
import type { FolderEntry } from '@renderer/hooks/use-folder-entries'
import { driveTree, foldersToList, presentRecordGroups, recordPlaceOf, splitFrontPages, withRecordGroups, type DriveListing } from './team-brain-drive'

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

describe('withRecordGroups with none on', () => {
  it('drops the team record from the top, so its folders are neither shown nor listed', () => {
    const listed: DriveListing = new Map([['', [dir('_brain'), dir('company'), file('INDEX.md'), file('README.md')]]])
    const hidden = withRecordGroups(listed, new Set())
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

describe('the team record’s groups', () => {
  // A brain as the template builds it, plus a page the agent added and a hidden file.
  const listed: DriveListing = new Map([
    ['', [dir('_brain'), dir('customers'), file('INDEX.md'), file('README.md')]],
    ['_brain', [file('_brain/team.md'), file('_brain/sources.md'), file('_brain/changelog.md'), file('_brain/glossary.md'), dir('_brain/archive'), dir('_brain/syncs'), file('_brain/.keep')]],
  ])
  const top = (listing: DriveListing) => listing.get('')?.map((entry) => entry.path)
  const brain = (listing: DriveListing) => listing.get('_brain')?.map((entry) => entry.path)

  it('places each path by where it sits, not its name', () => {
    expect(['INDEX.md', '_brain/team.md', '_brain/changelog.md', '_brain/glossary.md', '_brain/index.md', '_brain/sources'].map(recordPlaceOf)).toEqual(Array(6).fill('about'))
    expect(['_brain/archive', '_archive'].map(recordPlaceOf)).toEqual(['archive', 'archive'])
    expect(recordPlaceOf('_brain/syncs')).toBe('syncs')
    expect(['customers', 'README.md', 'archive'].map(recordPlaceOf)).toEqual(['team', 'team', 'team'])
  })

  it('shows the team’s knowledge alone with no group on', () => {
    expect(top(withRecordGroups(listed, new Set()))).toEqual(['customers', 'README.md'])
  })

  it('shows each group’s paths alone, and never the sync summaries', () => {
    const about = withRecordGroups(listed, new Set(['about']))
    expect(top(about)).toEqual(['_brain', 'customers', 'INDEX.md', 'README.md'])
    expect(brain(about)).toEqual(['_brain/team.md', '_brain/sources.md', '_brain/changelog.md', '_brain/glossary.md'])
    const archive = withRecordGroups(listed, new Set(['archive']))
    expect(top(archive)).toEqual(['_brain', 'customers', 'README.md'])
    expect(brain(archive)).toEqual(['_brain/archive'])
    expect(brain(withRecordGroups(listed, new Set(['about', 'archive'])))).not.toContain('_brain/syncs')
  })

  it('drops _brain when a group on has nothing in it', () => {
    const syncsOnly: DriveListing = new Map([['', [dir('_brain'), dir('customers')]], ['_brain', [dir('_brain/syncs')]]])
    expect(top(withRecordGroups(syncsOnly, new Set(['about', 'archive'])))).toEqual(['customers'])
    const hiddenOnly: DriveListing = new Map([['', [dir('_brain')]], ['_brain', [file('_brain/.keep')]]])
    expect(top(withRecordGroups(hiddenOnly, new Set(['about'])))).toEqual([])
  })

  it('keeps _brain while it is not listed yet, so a group on in it gets it listed', () => {
    const unlisted: DriveListing = new Map([['', [dir('_brain'), file('INDEX.md')]]])
    expect(top(withRecordGroups(unlisted, new Set(['archive'])))).toEqual(['_brain'])
  })

  it('puts an older brain’s top-level _archive under Archive', () => {
    const legacy: DriveListing = new Map([['', [dir('_archive'), dir('customers')]]])
    expect(top(withRecordGroups(legacy, new Set()))).toEqual(['customers'])
    expect(top(withRecordGroups(legacy, new Set(['archive'])))).toEqual(['_archive', 'customers'])
    expect([...presentRecordGroups(legacy)]).toEqual(['archive'])
  })

  it('finds a group only where it has something, never from the sync summaries or a hidden file', () => {
    expect([...presentRecordGroups(listed)].sort()).toEqual(['about', 'archive'])
    expect([...presentRecordGroups(new Map([['', [dir('_brain'), dir('customers')]], ['_brain', [dir('_brain/syncs'), file('_brain/.keep')]]]))]).toEqual([])
  })
})
