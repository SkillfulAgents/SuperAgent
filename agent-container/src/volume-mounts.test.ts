import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parseVolumes, rcloneMountArgs, untilMountAnswers } from './volume-mounts'

describe('parseVolumes', () => {
  it('accepts names that are one path segment', () => {
    const raw = JSON.stringify([{ volumeId: 'v_17', name: 'team brain' }])
    expect(parseVolumes(raw)).toEqual([{ volumeId: 'v_17', name: 'team brain' }])
  })

  it.each(['..', 'a/b'])('rejects the whole list when a name is %j', (name) => {
    const raw = JSON.stringify([{ volumeId: 'v_1', name: 'ok' }, { volumeId: 'v_2', name }])
    expect(parseVolumes(raw)).toEqual([])
  })

  it.each(['', '..'])('rejects the whole list when a volumeId is %j', (volumeId) => {
    const raw = JSON.stringify([{ volumeId: 'v_1', name: 'ok' }, { volumeId, name: 'other' }])
    expect(parseVolumes(raw)).toEqual([])
  })
})

describe('rcloneMountArgs', () => {
  it("points rclone at the volume's address under the host API, and the driver settings", () => {
    const args = rcloneMountArgs('v_17', '/mounts/docs', 'http://host.docker.internal:47891/api')
    expect(args).toEqual([
      'mount', ':webdav:', '/mounts/docs', '--webdav-url', 'http://host.docker.internal:47891/api/volumes/v_17',
      '--vfs-cache-mode', 'writes', '--vfs-write-back', '0s', '--dir-cache-time', '1s',
      '--file-perms', '0777',
    ])
  })
})

describe('untilMountAnswers', () => {
  it('stops polling a path that never mounts once the attempt has settled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'volume-'))
    let settled = false
    setTimeout(() => { settled = true }, 50)
    await expect(untilMountAnswers(dir, fs.statSync(dir).dev, () => settled)).resolves.toBeUndefined()
    fs.rmSync(dir, { recursive: true })
  })
})
