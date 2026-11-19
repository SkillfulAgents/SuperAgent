import { describe, expect, it } from 'vitest'
import { LocalMountableVolume } from './local-mountable-volume'
import { PlatformMountableVolume } from './platform-mountable-volume'
import { browseVolumeFolders, createVolumeFolder, instantiateVolume, prepareVolume, sourceKey } from './volume-factory'

describe('instantiateVolume', () => {
  it('loads a saved Gamut drive by its id, a definition saved with its location included', () => {
    const volumeId = 'vol_00000000-0000-0000-0000-000000000001'
    const volume = instantiateVolume({ id: 'v3', name: 'Docs', type: 'platform', config: { volumeId, bucket: 'gamut', prefix: `org-1/volumes/${volumeId}` } })
    expect(volume).toBeInstanceOf(PlatformMountableVolume)
    expect(volume?.config).toEqual({ volumeId })
  })

  it("builds the subclass for a row's type, and nothing for a config that is not that type's", () => {
    const volume = instantiateVolume({ id: 'v1', name: 'notes', type: 'local', config: { path: '/tmp/notes' } })
    expect(volume).toBeInstanceOf(LocalMountableVolume)
    expect(volume?.mountPath).toBe('/mounts/notes')
    expect(volume?.hostPath).toBe('/tmp/notes')
    expect(instantiateVolume({ id: 'v2', name: 'notes', type: 'local', config: { folder: '/tmp/notes' } })).toBeNull()
  })
})

describe('sourceKey', () => {
  const github = { accountId: 'a1', repoId: 7, owner: 'o', repo: 'r', branch: 'main', path: 'docs' }
  const folder = { accountId: 'a1', folderId: 'f1', folderName: 'Docs', driveName: 'My Drive' }
  const bucket = { endpoint: 'https://s3.example.com/', region: 'us-east-1', bucket: 'team', prefix: 'docs', forcePathStyle: true, credentials: { sealed: 'A'.repeat(48) } }
  const platform = 'vol_00000000-0000-0000-0000-000000000001'
  it.each([
    ['github', github, { ...github, owner: 'renamed' }, { ...github, accountId: 'a2' }],
    ['github', github, { ...github, repo: 'renamed' }, { ...github, branch: 'dev' }],
    ['dropbox', { accountId: 'a1', path: '/Team' }, { accountId: 'a1', path: '/team' }, { accountId: 'a2', path: '/Team' }],
    ['googledrive', folder, { ...folder, folderName: 'Renamed' }, { ...folder, accountId: 'a2' }],
    ['s3', bucket, { ...bucket, endpoint: 'https://s3.example.com', credentials: { sealed: 'B'.repeat(48) } }, { ...bucket, prefix: 'other' }],
    ['local', { path: '/tmp/notes' }, { path: '/tmp/notes', bookmark: 'b' }, { path: '/tmp/other' }],
    ['platform', { volumeId: platform }, { volumeId: platform, bucket: 'gamut' }, { volumeId: platform.replace(/1$/, '2') }],
  ] as const)('%s: same files through the same account match, other files or another account do not', (type, config, same, other) => {
    const key = sourceKey({ type, config })
    expect(key).not.toBeNull()
    expect(sourceKey({ type, config: same })).toBe(key)
    expect(sourceKey({ type, config: other })).not.toBe(key)
  })
  it('has no key for a config that is not the type’s', () => {
    expect(sourceKey({ type: 'local', config: { folder: '/tmp/notes' } })).toBeNull()
  })
})

describe('prepareVolume', () => {
  it('saves a Gamut drive only by id: a name to create one is refused before any platform call', async () => {
    await expect(prepareVolume('platform', { name: 'Launch' })).rejects.toThrow('Invalid volume config')
  })

  it('refuses a type it does not list, a name read off the prototype included', async () => {
    await expect(prepareVolume('gdrive', {})).rejects.toThrow('Unknown volume type')
    await expect(prepareVolume('toString', {})).rejects.toThrow('Unknown volume type')
  })
})

describe('browseVolumeFolders', () => {
  it('rejects unknown types, including prototype properties, and does not expose local folders', async () => {
    const viewer = { userId: 'alice' }
    await expect(browseVolumeFolders('unknown', {}, viewer)).rejects.toMatchObject({ status: 404 })
    await expect(browseVolumeFolders('toString', {}, viewer)).rejects.toMatchObject({ status: 404 })
    await expect(browseVolumeFolders('local', { path: '/' }, viewer)).rejects.toMatchObject({ status: 400 })
  })
})

describe('createVolumeFolder', () => {
  it('rejects unknown types, and a type that cannot make folders from setup', async () => {
    const viewer = { userId: 'alice' }
    await expect(createVolumeFolder('toString', {}, viewer)).rejects.toMatchObject({ status: 404 })
    await expect(createVolumeFolder('s3', { bucket: 'b', name: 'x' }, viewer)).rejects.toMatchObject({ status: 400 })
  })
})
