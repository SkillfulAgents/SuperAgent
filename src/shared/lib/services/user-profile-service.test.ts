import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let directory: string
let database: typeof import('@shared/lib/db')
let profiles: typeof import('./user-profile-service')
const override = '/api/profile/images/00000000-0000-4000-8000-000000000001.png'

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'user-profiles-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', directory)
  database = await import('@shared/lib/db')
  profiles = await import('./user-profile-service')
  const { user } = await import('@shared/lib/db/schema')
  database.db.insert(user).values([
    { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.test', image: 'https://example.test/ada.png', avatarOverride: override, role: 'admin' },
    { id: 'maya', name: 'Maya Chen', email: 'maya@example.test', image: 'https://example.test/maya.png' },
    { id: 'percent', name: '100% Person', email: 'percent@example.test', image: 'javascript:invalid' },
    { id: 'underscore', name: 'Under_score', email: 'underscore@example.test' },
    { id: 'backslash', name: 'Back\\slash', email: 'backslash@example.test' },
    ...Array.from({ length: 55 }, (_, index) => ({
      id: `team-${index}`, name: `Team Person ${index}`, email: `team-${index}@example.test`,
    })),
  ]).run()
})

afterAll(() => {
  database.sqlite.close()
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('user profile reads', () => {
  it('resolves distinct requested users with effective images and no internal fields', () => {
    const result = profiles.getUserSummaries(['ada', 'ada', 'missing', 'maya', 'percent'])
    expect(result.size).toBe(3)
    expect(result.get('ada')).toEqual({ id: 'ada', name: 'Ada Lovelace', email: 'ada@example.test', image: override })
    expect(result.get('maya')?.image).toBe('https://example.test/maya.png')
    expect(result.get('percent')?.image).toBeNull()
    expect(profiles.getUserSummaries([]).size).toBe(0)
    expect(profiles.userExists('ada')).toBe(true)
    expect(profiles.userExists('missing')).toBe(false)
  })

  it('keeps live sender summaries limited to the existing event fields', () => {
    const user = { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.test', image: 'https://example.test/ada.png', avatarOverride: override, role: 'admin' }
    expect(profiles.toUserSender(user)).toEqual({ id: 'ada', name: 'Ada Lovelace', image: override })
  })

  it.each([
    ['  ADA  ', 'ada'],
    ['MAYA@EXAMPLE', 'maya'],
    ['%', 'percent'],
    ['_', 'underscore'],
    ['\\', 'backslash'],
  ])('searches names and emails literally for %s', (query, expectedId) => {
    expect(profiles.searchUserSummaries(query, []).map(profile => profile.id)).toEqual([expectedId])
  })

  it('excludes current members before applying the invitation result limit', () => {
    const existing = profiles.searchUserSummaries('Team Person', [])
    expect(existing).toHaveLength(50)
    const remaining = profiles.searchUserSummaries('Team Person', existing.map(profile => profile.id))
    expect(remaining).toHaveLength(5)
    expect(remaining.every(profile => !existing.some(member => member.id === profile.id))).toBe(true)
    expect(profiles.searchUserSummaries(undefined, [])).toHaveLength(50)
  })
})
