import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addMount } from '@shared/lib/services/mount-service'
import { resolveVolume } from './volumes'

describe('resolveVolume', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'volumes-test-')))
    process.env.SUPERAGENT_DATA_DIR = tmpDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.SUPERAGENT_DATA_DIR
  })

  it("resolves an agent's own volume, and nothing for another agent's or an unknown id", async () => {
    const folder = path.join(tmpDir, 'notes')
    fs.mkdirSync(folder)
    fs.writeFileSync(path.join(folder, 'a.txt'), 'a')
    const mount = await addMount('agent-a', folder)

    const volume = await resolveVolume('agent-a', mount.id)
    if (!volume) throw new Error('expected the volume to resolve')
    expect((await volume.list('')).map((entry) => entry.name)).toEqual(['a.txt'])
    expect(await resolveVolume('agent-b', mount.id)).toBeNull()
    expect(await resolveVolume('agent-a', 'unknown')).toBeNull()
  })
})
