import { describe, it, expect } from 'vitest'
import { agentFolderSettingsWriteSchema, userSettingsSchema } from './user-settings-service'

describe('userSettingsSchema agentOrder', () => {
  it('defaults to undefined when not provided', () => {
    const result = userSettingsSchema.parse({})
    expect(result.agentOrder).toBeUndefined()
  })

  it('accepts a valid array of slugs', () => {
    const result = userSettingsSchema.parse({ agentOrder: ['a', 'b', 'c'] })
    expect(result.agentOrder).toEqual(['a', 'b', 'c'])
  })

  it('accepts an empty array', () => {
    const result = userSettingsSchema.parse({ agentOrder: [] })
    expect(result.agentOrder).toEqual([])
  })

  it('rejects non-string array elements', () => {
    expect(() => userSettingsSchema.parse({ agentOrder: [1, 2] })).toThrow()
  })

  it('rejects non-array values', () => {
    expect(() => userSettingsSchema.parse({ agentOrder: 'not-array' })).toThrow()
  })

  it('survives a round-trip through JSON', () => {
    const original = userSettingsSchema.parse({ agentOrder: ['x', 'y'] })
    const roundTripped = userSettingsSchema.parse(JSON.parse(JSON.stringify(original)))
    expect(roundTripped.agentOrder).toEqual(['x', 'y'])
  })

  it('replaces agentOrder on spread merge (not deep-merged)', () => {
    const current = userSettingsSchema.parse({ agentOrder: ['a', 'b', 'c'] })
    const partial = { agentOrder: ['c', 'a'] }
    const merged = { ...current, ...partial }
    const result = userSettingsSchema.parse(merged)
    expect(result.agentOrder).toEqual(['c', 'a'])
  })
})

describe('userSettingsSchema home grid layouts', () => {
  it('keeps desktop and mobile geometry as independent optional maps', () => {
    const result = userSettingsSchema.parse({
      homeGridLayout: {
        agent: { x: 4, y: 0, w: 2, h: 1 },
      },
      homeGridMobileLayout: {
        agent: { x: 1, y: 3, w: 1, h: 1 },
      },
    })

    expect(result.homeGridLayout?.agent).toEqual({ x: 4, y: 0, w: 2, h: 1 })
    expect(result.homeGridMobileLayout?.agent).toEqual({ x: 1, y: 3, w: 1, h: 1 })
  })

  it('leaves the mobile layout absent for migration-safe desktop fallback', () => {
    const result = userSettingsSchema.parse({
      homeGridLayout: {
        agent: { x: 0, y: 0, w: 2, h: 1 },
      },
    })

    expect(result.homeGridMobileLayout).toBeUndefined()
  })
})

describe('userSettingsSchema agent folders', () => {
  it('leaves every folder field absent when not provided', () => {
    const result = userSettingsSchema.parse({})
    expect(result.agentFolders).toBeUndefined()
    expect(result.agentFolderAssignments).toBeUndefined()
    expect(result.agentListOrder).toBeUndefined()
    expect(result.collapsedAgentFolders).toBeUndefined()
  })

  it('accepts a folder list and a slug→folder map', () => {
    const result = userSettingsSchema.parse({
      agentFolders: [{ id: 'f1', name: 'Work' }],
      agentFolderAssignments: { 'my-agent': 'f1' },
      collapsedAgentFolders: ['f1'],
    })
    expect(result.agentFolders).toEqual([{ id: 'f1', name: 'Work' }])
    expect(result.agentFolderAssignments).toEqual({ 'my-agent': 'f1' })
    expect(result.collapsedAgentFolders).toEqual(['f1'])
  })

  it('accepts a top-level order mixing agent slugs and folder markers', () => {
    const result = userSettingsSchema.parse({
      agentListOrder: ['my-agent', 'agent-folder::f1', 'other-agent'],
    })
    expect(result.agentListOrder).toEqual(['my-agent', 'agent-folder::f1', 'other-agent'])
  })

  it('keeps an order entry naming something that no longer exists', () => {
    // buildAgentList ignores unresolvable entries at render time, which is what
    // lets agent and folder deletion skip repairing this array.
    const result = userSettingsSchema.parse({
      agentListOrder: ['agent-folder::deleted', 'gone-agent'],
    })
    expect(result.agentListOrder).toEqual(['agent-folder::deleted', 'gone-agent'])
  })

  it('drops a malformed top-level order instead of failing the whole document', () => {
    const result = userSettingsSchema.parse({ theme: 'dark', agentListOrder: { nope: 1 } })
    expect(result.agentListOrder).toBeUndefined()
    expect(result.theme).toBe('dark')
  })

  it('allows an empty folder name so a rename can be cleared mid-edit', () => {
    const result = userSettingsSchema.parse({ agentFolders: [{ id: 'f1', name: '' }] })
    expect(result.agentFolders).toEqual([{ id: 'f1', name: '' }])
  })

  it('keeps an assignment pointing at a folder that no longer exists', () => {
    // Dangling assignments are resolved at render time (they fall back to the
    // ungrouped root), so the schema must not reject or strip them — that is
    // what lets folder deletion skip a cascade.
    const result = userSettingsSchema.parse({
      agentFolders: [],
      agentFolderAssignments: { 'my-agent': 'deleted-folder' },
    })
    expect(result.agentFolderAssignments).toEqual({ 'my-agent': 'deleted-folder' })
  })

  it('drops a malformed folder list instead of failing the whole document', () => {
    // getUserSettings() falls back to ALL defaults if the document fails to
    // parse, so a bad folder blob must not be able to blank out theme or
    // notification preferences.
    const result = userSettingsSchema.parse({
      theme: 'dark',
      agentFolders: 'not-an-array',
    })
    expect(result.agentFolders).toBeUndefined()
    expect(result.theme).toBe('dark')
  })

  it('drops a malformed assignments map instead of failing the whole document', () => {
    const result = userSettingsSchema.parse({
      theme: 'dark',
      agentFolderAssignments: [1, 2, 3],
    })
    expect(result.agentFolderAssignments).toBeUndefined()
    expect(result.theme).toBe('dark')
  })

  it('drops a folder entry missing an id without taking its siblings down', () => {
    // Array validation must be per-element: the whole document is rewritten on
    // every settings write, so an all-or-nothing failure here would turn one
    // corrupt entry into permanent loss of every good folder on the next
    // unrelated write.
    const result = userSettingsSchema.parse({
      agentFolders: [{ id: 'f1', name: 'Work' }, { name: 'no-id' }, { id: 'f2', name: 'Home' }],
    })
    expect(result.agentFolders).toEqual([
      { id: 'f1', name: 'Work' },
      { id: 'f2', name: 'Home' },
    ])
  })

  it('drops a non-string assignment value without taking the rest of the map down', () => {
    const result = userSettingsSchema.parse({
      agentFolderAssignments: { 'my-agent': 'f1', 'other-agent': 5 },
    })
    expect(result.agentFolderAssignments).toEqual({ 'my-agent': 'f1' })
  })

  it('drops a non-string order entry without taking the rest of the order down', () => {
    const result = userSettingsSchema.parse({
      agentListOrder: ['agent-folder::f1', 42, 'agent-folder::f2'],
    })
    expect(result.agentListOrder).toEqual(['agent-folder::f1', 'agent-folder::f2'])
  })

  it('survives a round-trip through JSON', () => {
    const original = userSettingsSchema.parse({
      agentFolders: [{ id: 'f1', name: 'Work' }],
      agentFolderAssignments: { 'my-agent': 'f1' },
      agentListOrder: ['agent-folder::f1', 'my-agent'],
    })
    const roundTripped = userSettingsSchema.parse(JSON.parse(JSON.stringify(original)))
    expect(roundTripped.agentFolders).toEqual([{ id: 'f1', name: 'Work' }])
    expect(roundTripped.agentFolderAssignments).toEqual({ 'my-agent': 'f1' })
    expect(roundTripped.agentListOrder).toEqual(['agent-folder::f1', 'my-agent'])
  })

  it('replaces the folder list on spread merge (not deep-merged)', () => {
    const current = userSettingsSchema.parse({
      agentFolders: [{ id: 'f1', name: 'Work' }, { id: 'f2', name: 'Personal' }],
    })
    const merged = { ...current, ...{ agentFolders: [{ id: 'f2', name: 'Personal' }] } }
    const result = userSettingsSchema.parse(merged)
    expect(result.agentFolders).toEqual([{ id: 'f2', name: 'Personal' }])
  })
})

describe('agentFolderSettingsWriteSchema', () => {
  // The stored schema above is lenient by design — reads must survive a
  // corrupt blob — which means it can only DROP bad input, never reject it.
  // On the write path that leniency would silently erase the field a
  // malformed PUT targets, so the API route validates against this strict
  // schema first and refuses the write instead.

  it('accepts a well-formed folder write alongside unrelated fields', () => {
    const result = agentFolderSettingsWriteSchema.safeParse({
      theme: 'dark',
      agentFolders: [{ id: 'f1', name: 'Work' }],
      agentFolderAssignments: { 'my-agent': 'f1' },
      agentListOrder: ['agent-folder::root', 'agent-folder::f1'],
      collapsedAgentFolders: ['f1'],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a write that touches none of the folder fields', () => {
    expect(agentFolderSettingsWriteSchema.safeParse({ theme: 'dark' }).success).toBe(true)
  })

  it('rejects a folder entry missing an id instead of dropping it', () => {
    const result = agentFolderSettingsWriteSchema.safeParse({
      agentFolders: [{ id: 'f1', name: 'Work' }, { name: 'no-id' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a non-array folder list instead of erasing the stored one', () => {
    expect(agentFolderSettingsWriteSchema.safeParse({ agentFolders: null }).success).toBe(false)
  })

  it('rejects a non-string assignment value instead of dropping it', () => {
    const result = agentFolderSettingsWriteSchema.safeParse({
      agentFolderAssignments: { 'my-agent': 5 },
    })
    expect(result.success).toBe(false)
  })

  it('rejects a non-object body', () => {
    expect(agentFolderSettingsWriteSchema.safeParse(null).success).toBe(false)
    expect(agentFolderSettingsWriteSchema.safeParse([1]).success).toBe(false)
  })
})
