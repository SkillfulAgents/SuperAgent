import { describe, it, expect, vi } from 'vitest'

vi.mock('./registry', () => ({
  EXPERIMENTS: [
    { id: 'alpha', name: 'Alpha', description: 'The first one.' },
    { id: 'beta', name: 'Beta', description: 'The second one.' },
  ],
}))

import { experimentEnabled, isKnownExperiment, listExperiments } from '.'
import { experimentSettingsWriteSchema, userSettingsSchema } from '@shared/lib/services/user-settings-service'

describe('experiment registry', () => {
  it('lists the registry in order', () => {
    expect(listExperiments().map((e) => e.id)).toEqual(['alpha', 'beta'])
  })

  it('knows only listed ids', () => {
    expect(isKnownExperiment('alpha')).toBe(true)
    expect(isKnownExperiment('retired')).toBe(false)
  })
})

describe('experimentEnabled', () => {
  it('is on only for a listed id switched on', () => {
    expect(experimentEnabled({ alpha: true, beta: false }, 'alpha')).toBe(true)
    expect(experimentEnabled({ alpha: true, beta: false }, 'beta')).toBe(false)
  })

  it('is off when nothing is stored', () => {
    expect(experimentEnabled(undefined, 'alpha')).toBe(false)
    expect(experimentEnabled({}, 'alpha')).toBe(false)
  })

  it('ignores a stored switch for an experiment that has been retired', () => {
    expect(experimentEnabled({ retired: true }, 'retired')).toBe(false)
  })
})

describe('experiment switches in user settings', () => {
  it('are absent by default', () => {
    expect(userSettingsSchema.parse({}).experiments).toBeUndefined()
  })

  it('keep a retired id as stored, so readers can ignore it', () => {
    expect(userSettingsSchema.parse({ experiments: { alpha: true, retired: true } }).experiments)
      .toEqual({ alpha: true, retired: true })
  })

  it('drop a malformed value alone, without taking the rest of the document with it', () => {
    const parsed = userSettingsSchema.parse({ theme: 'dark', experiments: { alpha: 'yes', beta: true } })
    expect(parsed.experiments).toEqual({ beta: true })
    expect(parsed.theme).toBe('dark')
  })

  it('drop a malformed map instead of failing the document', () => {
    const parsed = userSettingsSchema.parse({ theme: 'dark', experiments: ['alpha'] })
    expect(parsed.experiments).toBeUndefined()
    expect(parsed.theme).toBe('dark')
  })

  it('a write may name only listed experiments, with boolean values', () => {
    expect(experimentSettingsWriteSchema.safeParse({ experiments: { alpha: true } }).success).toBe(true)
    expect(experimentSettingsWriteSchema.safeParse({ experiments: { retired: true } }).success).toBe(false)
    expect(experimentSettingsWriteSchema.safeParse({ experiments: { alpha: 'on' } }).success).toBe(false)
    expect(experimentSettingsWriteSchema.safeParse({ theme: 'dark' }).success).toBe(true)
  })
})
