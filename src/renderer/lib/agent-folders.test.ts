import { describe, it, expect } from 'vitest'
import {
  ROOT_FOLDER_ID,
  assignAgentToFolder,
  buildFolderSections,
  containerIdForFolder,
  dissolveFolder,
  locateAgent,
  moveAgent,
  moveFolder,
  newFolderId,
  applyTreeOperation,
  resolveAgentDrop,
  resolveFolderDrop,
  sanitizeFolders,
  sectionsToSettings,
  sortableIdForFolder,
  uniqueFolderName,
  type AgentFolder,
  type FolderSection,
} from './agent-folders'
import type { ApiAgent } from '@renderer/hooks/use-agents'

function makeAgent(slug: string): ApiAgent {
  return {
    slug,
    displaySlug: slug,
    name: slug,
    createdAt: new Date('2025-01-01'),
    status: 'stopped',
    containerPort: null,
  }
}

const a = makeAgent('a')
const b = makeAgent('b')
const c = makeAgent('c')
const d = makeAgent('d')
const work: AgentFolder = { id: 'f1', name: 'Work' }
const personal: AgentFolder = { id: 'f2', name: 'Personal' }

/** Compact shape: 'root[a,b]' then 'f1[c]' in render order. */
function shapeOf(sections: FolderSection[]): string[] {
  return sections.map((s) => `${s.folder.id}[${s.agents.map((x) => x.slug).join(',')}]`)
}

const F1 = sortableIdForFolder('f1')
const F2 = sortableIdForFolder('f2')
const ROOT = sortableIdForFolder(ROOT_FOLDER_ID)

describe('buildFolderSections', () => {
  it('renders every agent inside the default folder when there are no others', () => {
    expect(shapeOf(buildFolderSections([a, b], undefined, undefined, undefined)))
      .toEqual(['root[a,b]'])
  })

  it('renders one section per folder id even if the stored list repeats it', () => {
    const sections = buildFolderSections(
      [a, b],
      [{ id: 'f1', name: 'Work' }, { id: 'f1', name: 'Twin' }],
      { a: 'f1' },
      undefined
    )
    expect(shapeOf(sections)).toEqual(['root[b]', 'f1[a]'])
  })

  it('always renders the default folder, even empty', () => {
    const sections = buildFolderSections([a], [work], { a: 'f1' }, undefined)
    expect(shapeOf(sections)).toEqual(['root[]', 'f1[a]'])
    expect(sections[0].isRoot).toBe(true)
    expect(sections[0].folder.name).toBe('Your Agents')
  })

  it('defaults the default folder first — the pre-folders layout on an untouched install', () => {
    const sections = buildFolderSections([a, b], [work], { a: 'f1' }, undefined)
    expect(shapeOf(sections)).toEqual(['root[b]', 'f1[a]'])
  })

  it('orders folders by the stored top-level order, default folder included', () => {
    const sections = buildFolderSections([a, b], [work], { a: 'f1' }, [F1, ROOT])
    expect(shapeOf(sections)).toEqual(['f1[a]', 'root[b]'])
  })

  it('ranks a folder with no stored place last — it was just created', () => {
    const sections = buildFolderSections([a], [work, personal], { a: 'f1' }, [F1, ROOT])
    expect(shapeOf(sections)).toEqual(['f1[a]', 'root[]', 'f2[]'])
  })

  it('ignores stored order entries that are agent slugs — the pre-refactor format', () => {
    // The top level used to interleave agents and folders; those blobs must
    // parse under the new model with the folder markers keeping their order.
    const sections = buildFolderSections([a, b], [work], { b: 'f1' }, ['a', F1, 'deleted', ROOT])
    expect(shapeOf(sections)).toEqual(['f1[b]', 'root[a]'])
  })

  it('preserves the incoming agent order inside each section', () => {
    const sections = buildFolderSections([c, a, b], [work], { a: 'f1', c: 'f1' }, undefined)
    expect(shapeOf(sections)).toEqual(['root[b]', 'f1[c,a]'])
  })

  it('drops an agent whose folder no longer exists into the default folder', () => {
    const sections = buildFolderSections([a, b], [work], { a: 'f1', b: 'gone' }, undefined)
    expect(shapeOf(sections)).toEqual(['root[b]', 'f1[a]'])
  })

  it('ignores assignments for agents that are not in the list', () => {
    const sections = buildFolderSections([a], [work], { a: 'f1', ghost: 'f1' }, undefined)
    expect(shapeOf(sections)).toEqual(['root[]', 'f1[a]'])
  })

  it('discards a stored folder that claims the default folder id', () => {
    const sections = buildFolderSections([a], [{ id: ROOT_FOLDER_ID, name: 'Impostor' }], {}, undefined)
    expect(shapeOf(sections)).toEqual(['root[a]'])
    expect(sections[0].folder.name).toBe('Your Agents')
  })
})

describe('sectionsToSettings', () => {
  it('flattens reading order into agentOrder', () => {
    const sections = buildFolderSections([a, b, c], [work], { b: 'f1' }, [F1, ROOT])
    expect(sectionsToSettings(sections).agentOrder).toEqual(['b', 'a', 'c'])
  })

  it('records the top level as folder markers only', () => {
    const sections = buildFolderSections([a], [work], {}, [F1, ROOT])
    expect(sectionsToSettings(sections).agentListOrder).toEqual([F1, ROOT])
  })

  it('writes no assignment for default-folder members', () => {
    const sections = buildFolderSections([a, b], [work], { b: 'f1' }, undefined)
    expect(sectionsToSettings(sections).agentFolderAssignments).toEqual({ b: 'f1' })
  })

  it('does not write the default folder into agentFolders', () => {
    const sections = buildFolderSections([a], [work], {}, undefined)
    expect(sectionsToSettings(sections).agentFolders).toEqual([work])
  })

  it('round-trips through buildFolderSections unchanged', () => {
    const original = buildFolderSections([a, b, c, d], [work, personal], { a: 'f2', c: 'f1' }, [
      F2, ROOT, F1,
    ])
    const settings = sectionsToSettings(original)
    const reparsed = buildFolderSections(
      settings.agentOrder.map((slug) => [a, b, c, d].find((x) => x.slug === slug)!),
      settings.agentFolders,
      settings.agentFolderAssignments,
      settings.agentListOrder
    )
    expect(shapeOf(reparsed)).toEqual(shapeOf(original))
  })
})

describe('resolveAgentDrop', () => {
  const sections = buildFolderSections([a, b, c], [work], { b: 'f1' }, undefined)

  it('files into a folder at the end when dropped on its header or body', () => {
    expect(resolveAgentDrop(sections, F1)).toEqual({ folderId: 'f1', index: 1 })
    expect(resolveAgentDrop(sections, containerIdForFolder('f1'))).toEqual({ folderId: 'f1', index: 1 })
  })

  it('treats the default folder like any other target', () => {
    expect(resolveAgentDrop(sections, ROOT)).toEqual({ folderId: ROOT_FOLDER_ID, index: 2 })
    expect(resolveAgentDrop(sections, containerIdForFolder(ROOT_FOLDER_ID)))
      .toEqual({ folderId: ROOT_FOLDER_ID, index: 2 })
  })

  it('takes the slot of the row it is dropped on', () => {
    expect(resolveAgentDrop(sections, 'c')).toEqual({ folderId: ROOT_FOLDER_ID, index: 1 })
    expect(resolveAgentDrop(sections, 'b')).toEqual({ folderId: 'f1', index: 0 })
  })

  it('returns null for anything unrecognised', () => {
    expect(resolveAgentDrop(sections, 'nope')).toBeNull()
  })
})

describe('resolveFolderDrop', () => {
  const sections = buildFolderSections([a, b, c], [work, personal], { b: 'f1' }, [ROOT, F1, F2])

  it('takes the slot of a folder it is dropped on, default folder included', () => {
    expect(resolveFolderDrop(sections, F2)).toBe(2)
    expect(resolveFolderDrop(sections, ROOT)).toBe(0)
  })

  it('resolves an agent row to the slot of the section holding it', () => {
    expect(resolveFolderDrop(sections, 'a')).toBe(0)
    expect(resolveFolderDrop(sections, 'b')).toBe(1)
  })

  it('returns null for anything unrecognised', () => {
    expect(resolveFolderDrop(sections, 'nope')).toBeNull()
  })
})

describe('moveAgent', () => {
  it('reorders within the default folder', () => {
    const sections = buildFolderSections([a, b, c], undefined, undefined, undefined)
    expect(shapeOf(moveAgent(sections, 'a', { folderId: ROOT_FOLDER_ID, index: 2 })))
      .toEqual(['root[b,c,a]'])
  })

  it('files an agent into a folder at a given index', () => {
    const sections = buildFolderSections([a, b, c], [work], { b: 'f1', c: 'f1' }, undefined)
    expect(shapeOf(moveAgent(sections, 'a', { folderId: 'f1', index: 1 })))
      .toEqual(['root[]', 'f1[b,a,c]'])
  })

  it('appends when the index is past the end', () => {
    const sections = buildFolderSections([a, b], [work], { b: 'f1' }, undefined)
    expect(shapeOf(moveAgent(sections, 'a', { folderId: 'f1', index: 99 })))
      .toEqual(['root[]', 'f1[b,a]'])
  })

  it('unfiles by moving into the default folder at a chosen slot', () => {
    const sections = buildFolderSections([a, b, c], [work], { a: 'f1' }, undefined)
    expect(shapeOf(moveAgent(sections, 'a', { folderId: ROOT_FOLDER_ID, index: 1 })))
      .toEqual(['root[b,a,c]', 'f1[]'])
  })

  it('moves straight between two folders', () => {
    const sections = buildFolderSections([a, b], [work, personal], { a: 'f1', b: 'f2' }, undefined)
    expect(shapeOf(moveAgent(sections, 'a', { folderId: 'f2', index: 0 })))
      .toEqual(['root[]', 'f1[]', 'f2[a,b]'])
  })

  it('returns the same sections when the agent is unknown', () => {
    const sections = buildFolderSections([a], undefined, undefined, undefined)
    expect(moveAgent(sections, 'ghost', { folderId: ROOT_FOLDER_ID, index: 0 })).toBe(sections)
  })

  it('returns the same sections when the destination folder is gone', () => {
    const sections = buildFolderSections([a], undefined, undefined, undefined)
    expect(moveAgent(sections, 'a', { folderId: 'nope', index: 0 })).toBe(sections)
  })

  it('returns the same sections when nothing would move', () => {
    const sections = buildFolderSections([a, b], undefined, undefined, undefined)
    expect(moveAgent(sections, 'a', { folderId: ROOT_FOLDER_ID, index: 0 })).toBe(sections)
  })

  it('does not mutate its input', () => {
    const sections = buildFolderSections([a, b], [work], {}, undefined)
    const before = shapeOf(sections)
    moveAgent(sections, 'a', { folderId: 'f1', index: 0 })
    expect(shapeOf(sections)).toEqual(before)
  })
})

describe('moveFolder', () => {
  it('reorders folders past each other', () => {
    const sections = buildFolderSections([a], [work, personal], {}, [ROOT, F1, F2])
    expect(shapeOf(moveFolder(sections, 'f2', 1))).toEqual(['root[a]', 'f2[]', 'f1[]'])
  })

  it('moves the default folder like any other', () => {
    const sections = buildFolderSections([a, b], [work], { b: 'f1' }, [ROOT, F1])
    expect(shapeOf(moveFolder(sections, ROOT_FOLDER_ID, 1))).toEqual(['f1[b]', 'root[a]'])
  })

  it('carries a folder’s agents with it', () => {
    const sections = buildFolderSections([a, b, c], [work], { b: 'f1', c: 'f1' }, [ROOT, F1])
    expect(shapeOf(moveFolder(sections, 'f1', 0))).toEqual(['f1[b,c]', 'root[a]'])
  })

  it('clamps a slot past the end', () => {
    const sections = buildFolderSections([a], [work], {}, [ROOT, F1])
    expect(shapeOf(moveFolder(sections, ROOT_FOLDER_ID, 99))).toEqual(['f1[]', 'root[a]'])
  })

  it('is a no-op for an unknown folder', () => {
    const sections = buildFolderSections([a], [work], {}, undefined)
    expect(moveFolder(sections, 'nope', 0)).toBe(sections)
  })
})

describe('dissolveFolder', () => {
  it('appends the folder’s members to the default folder', () => {
    const sections = buildFolderSections([a, b, c], [work], { b: 'f1', c: 'f1' }, undefined)
    expect(shapeOf(dissolveFolder(sections, 'f1'))).toEqual(['root[a,b,c]'])
  })

  it('keeps the released agents’ relative order', () => {
    const sections = buildFolderSections([a, b, c, d], [work], { c: 'f1', b: 'f1' }, undefined)
    expect(shapeOf(dissolveFolder(sections, 'f1'))).toEqual(['root[a,d,b,c]'])
  })

  it('clears the released agents’ assignments when written back', () => {
    const sections = buildFolderSections([a, b], [work], { b: 'f1' }, undefined)
    const settings = sectionsToSettings(dissolveFolder(sections, 'f1'))
    expect(settings.agentFolderAssignments).toEqual({})
    expect(settings.agentFolders).toEqual([])
  })

  it('refuses to dissolve the default folder', () => {
    const sections = buildFolderSections([a], undefined, undefined, undefined)
    expect(dissolveFolder(sections, ROOT_FOLDER_ID)).toBe(sections)
  })

  it('is a no-op for an unknown folder', () => {
    const sections = buildFolderSections([a], [work], {}, undefined)
    expect(dissolveFolder(sections, 'nope')).toBe(sections)
  })
})

describe('locateAgent', () => {
  const sections = buildFolderSections([a, b], [work], { b: 'f1' }, undefined)

  it('finds agents in the default folder and in others', () => {
    expect(locateAgent(sections, 'a')).toEqual({ sectionIndex: 0, memberIndex: 0 })
    expect(locateAgent(sections, 'b')).toEqual({ sectionIndex: 1, memberIndex: 0 })
    expect(locateAgent(sections, 'zzz')).toBeNull()
  })
})

describe('assignAgentToFolder', () => {
  it('files an agent', () => {
    expect(assignAgentToFolder({}, 'a', 'f1')).toEqual({ a: 'f1' })
  })

  it('treats the default folder as unfiled — the key is deleted, not written', () => {
    expect(assignAgentToFolder({ a: 'f1' }, 'a', ROOT_FOLDER_ID)).toEqual({})
    expect(assignAgentToFolder({ a: 'f1' }, 'a', null)).toEqual({})
  })

  it('tolerates an absent assignments map and does not mutate its input', () => {
    expect(assignAgentToFolder(undefined, 'a', 'f1')).toEqual({ a: 'f1' })
    const original = { a: 'f1' }
    assignAgentToFolder(original, 'b', 'f2')
    expect(original).toEqual({ a: 'f1' })
  })
})

describe('uniqueFolderName', () => {
  it('suffixes a counter on collision', () => {
    expect(uniqueFolderName([])).toBe('New Folder')
    expect(uniqueFolderName([{ id: 'f1', name: 'New Folder' }])).toBe('New Folder 2')
  })

  it('deduplicates a typed base name against existing folders', () => {
    const folders = [
      { id: 'f1', name: 'Clients' },
      { id: 'f2', name: 'Clients 2' },
    ]
    expect(uniqueFolderName(folders, 'Clients')).toBe('Clients 3')
    expect(uniqueFolderName(folders, 'Fresh')).toBe('Fresh')
  })
})

describe('applyTreeOperation', () => {
  const base = () =>
    buildFolderSections([a, b, c], [work, personal], { a: 'f1' }, undefined)
  // base: root[b,c] f1[a] f2[]

  it('reproduces a drop exactly when nothing changed in between', () => {
    // placeAgent records the agent's FINAL member index; on the same sections
    // it must land precisely there — the serial case is byte-for-byte.
    const next = applyTreeOperation(base(), { kind: 'placeAgent', slug: 'b', folderId: 'f1', index: 0 })
    expect(shapeOf(next)).toEqual(['root[c]', 'f1[b,a]', 'f2[]'])
  })

  it('appends on an out-of-range index, which is how menu filing lands', () => {
    const next = applyTreeOperation(base(), {
      kind: 'placeAgent',
      slug: 'b',
      folderId: 'f1',
      index: Number.MAX_SAFE_INTEGER,
    })
    expect(shapeOf(next)).toEqual(['root[c]', 'f1[a,b]', 'f2[]'])
  })

  it('leaves the tree alone when the agent or folder vanished concurrently', () => {
    const sections = base()
    expect(applyTreeOperation(sections, { kind: 'placeAgent', slug: 'ghost', folderId: 'f1', index: 0 }))
      .toBe(sections)
    expect(applyTreeOperation(sections, { kind: 'placeAgent', slug: 'b', folderId: 'gone', index: 0 }))
      .toBe(sections)
    expect(applyTreeOperation(sections, { kind: 'placeFolder', folderId: 'gone', index: 0 }))
      .toBe(sections)
  })

  it('moves a folder to its recorded final slot, clamped past the end', () => {
    expect(shapeOf(applyTreeOperation(base(), { kind: 'placeFolder', folderId: 'f2', index: 0 })))
      .toEqual(['f2[]', 'root[b,c]', 'f1[a]'])
    expect(shapeOf(applyTreeOperation(base(), { kind: 'placeFolder', folderId: 'root', index: 99 })))
      .toEqual(['f1[a]', 'f2[]', 'root[b,c]'])
  })

  it('dissolves a folder into the default one', () => {
    expect(shapeOf(applyTreeOperation(base(), { kind: 'dissolveFolder', folderId: 'f1' })))
      .toEqual(['root[b,c,a]', 'f2[]'])
  })

  it('keeps work that landed while the drop was in flight', () => {
    // The whole point: a drop recorded against [root,f1,f2] re-applied to
    // sections where a THIRD folder was created concurrently keeps it.
    const withExtra = buildFolderSections(
      [a, b, c],
      [work, personal, { id: 'f9', name: 'Fresh' }],
      { a: 'f1', c: 'f9' },
      undefined
    )
    const next = applyTreeOperation(withExtra, { kind: 'placeAgent', slug: 'b', folderId: 'f1', index: 1 })
    expect(shapeOf(next)).toEqual(['root[]', 'f1[a,b]', 'f2[]', 'f9[c]'])
  })
})

describe('sanitizeFolders', () => {
  it('keeps only the first entry when two folders share an id', () => {
    // Two entries with one id would render two sections aliasing one member
    // array — moves into either would silently revert on the next write, a
    // state no gesture can repair — so the read boundary drops the repeat.
    expect(
      sanitizeFolders([
        { id: 'f1', name: 'Kept' },
        { id: 'f1', name: 'Dropped' },
        { id: 'f2', name: 'Other' },
      ])
    ).toEqual([
      { id: 'f1', name: 'Kept' },
      { id: 'f2', name: 'Other' },
    ])
  })

  it('drops a stored folder claiming the default folder id', () => {
    expect(sanitizeFolders([{ id: ROOT_FOLDER_ID, name: 'Impostor' }])).toEqual([])
  })

  it('passes a clean list through unchanged', () => {
    const folders = [{ id: 'f1', name: 'Work' }]
    expect(sanitizeFolders(folders)).toEqual(folders)
    expect(sanitizeFolders(undefined)).toEqual([])
  })
})

describe('newFolderId', () => {
  it('never mints the default folder id', () => {
    expect(newFolderId()).not.toBe(ROOT_FOLDER_ID)
  })
})
