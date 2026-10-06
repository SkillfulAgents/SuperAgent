import { describe, expect, it } from 'vitest'
import { LocalMountableVolume } from './local-mountable-volume'
import { instantiateVolume, prepareVolume } from './volume-factory'

describe('instantiateVolume', () => {
  it("builds the subclass for a row's type, and nothing for a config that is not that type's", () => {
    const volume = instantiateVolume({ id: 'v1', name: 'notes', type: 'local', config: { path: '/tmp/notes' } })
    expect(volume).toBeInstanceOf(LocalMountableVolume)
    expect(volume?.mountPath).toBe('/mounts/notes')
    expect(volume?.hostPath).toBe('/tmp/notes')
    expect(instantiateVolume({ id: 'v2', name: 'notes', type: 'local', config: { folder: '/tmp/notes' } })).toBeNull()
  })
})

describe('prepareVolume', () => {
  it('refuses a type it does not list, a name read off the prototype included', async () => {
    await expect(prepareVolume('gdrive', {})).rejects.toThrow('Unknown volume type')
    await expect(prepareVolume('toString', {})).rejects.toThrow('Unknown volume type')
  })
})
