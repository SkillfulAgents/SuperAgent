import { describe, it, expect } from 'vitest'
import { SHARED_VOLUME_NAME_RE, toSharedVolumeName } from './shared-volume-name'

describe('toSharedVolumeName', () => {
  it.each([
    ['Team Brain', 'team-brain'],
    ['  Q3 planning!! ', 'q3-planning'],
    ['--notes--', 'notes'],
    ['Café & Co', 'caf-co'],
  ])('converts %j to %j', (input, name) => {
    expect(toSharedVolumeName(input)).toBe(name)
  })

  it('always yields a name the server accepts, or nothing', () => {
    for (const input of ['', '!!!', ' - ', 'A'.repeat(80), `${'a'.repeat(49)} b`, 'Émile', '日本']) {
      const name = toSharedVolumeName(input)
      expect(name === '' || SHARED_VOLUME_NAME_RE.test(name)).toBe(true)
    }
  })
})
