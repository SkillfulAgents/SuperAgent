import { describe, expect, it } from 'vitest'
import { LocalMountableVolume } from './local-mountable-volume'
import { instantiateVolume } from './volume-types'

describe('instantiateVolume', () => {
  it('builds the subclass for a row\'s type, and nothing for an unknown type or a config that is not that type\'s', () => {
    const volume = instantiateVolume({ id: 'v1', name: 'notes', type: 'local', config: { path: '/tmp/notes' } })
    expect(volume).toBeInstanceOf(LocalMountableVolume)
    expect(volume?.mountPath).toBe('/mounts/notes')
    expect(volume?.hostPath).toBe('/tmp/notes')
    expect(instantiateVolume({ id: 'v2', name: 'drive', type: 'gdrive', config: {} })).toBeNull()
    expect(instantiateVolume({ id: 'v3', name: 'proto', type: 'toString', config: {} })).toBeNull()
    expect(instantiateVolume({ id: 'v4', name: 'notes', type: 'local', config: { folder: '/tmp/notes' } })).toBeNull()
  })
})
