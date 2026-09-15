import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  forgetAgentPlacement,
  loadAgentPlacement,
  loadAgentPlacements,
  modalVolumeNameFor,
  readAgentPlacement,
  writeAgentPlacement,
} from './placement'

describe('agent placement', () => {
  let dataDir: string
  let previousDataDir: string | undefined

  beforeEach(async () => {
    dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'placement-'))
    previousDataDir = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = dataDir
  })

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = previousDataDir
    for (const slug of ['fresh', 'remote', 'broken', 'other']) forgetAgentPlacement(slug)
    await fs.promises.rm(dataDir, { recursive: true, force: true })
  })

  it('an agent that was never loaded or written is local, without touching the disk', () => {
    expect(readAgentPlacement('fresh')).toEqual({ runtime: 'local' })
  })

  it('an agent without a placement document loads as local', async () => {
    expect(await loadAgentPlacement('fresh')).toEqual({ runtime: 'local' })
    expect(readAgentPlacement('fresh')).toEqual({ runtime: 'local' })
  })

  it('a written placement is read back at once, and loaded from disk again by a later process', async () => {
    await writeAgentPlacement('remote', { runtime: 'modal', volumeName: 'superagent-remote' })
    expect(readAgentPlacement('remote')).toEqual({ runtime: 'modal', volumeName: 'superagent-remote' })

    // The document is what survives a restart.
    const onDisk = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'agents', 'remote', 'placement.json'), 'utf-8'))
    expect(onDisk).toEqual({ runtime: 'modal', volumeName: 'superagent-remote' })

    forgetAgentPlacement('remote')
    expect(readAgentPlacement('remote')).toEqual({ runtime: 'local' })
    expect(await loadAgentPlacements(['remote', 'other'])).toEqual(['remote'])
    expect(readAgentPlacement('remote')).toEqual({ runtime: 'modal', volumeName: 'superagent-remote' })
    expect(readAgentPlacement('other')).toEqual({ runtime: 'local' })
  })

  it('a document that does not fit the schema is refused rather than loaded as local', async () => {
    const dir = path.join(dataDir, 'agents', 'broken')
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(path.join(dir, 'placement.json'), '{"runtime":"modal"}')
    await expect(loadAgentPlacement('broken')).rejects.toThrow(/unreadable placement document/)
    expect(readAgentPlacement('broken')).toEqual({ runtime: 'local' })
  })

  it('names the volume after the agent id in the character set Modal accepts', () => {
    expect(modalVolumeNameFor('agt_9f8e')).toBe('superagent-agt_9f8e')
    expect(modalVolumeNameFor('weird slug/with:chars')).toBe('superagent-weird-slug-with-chars')
    expect(modalVolumeNameFor('x'.repeat(100))).toHaveLength(63)
  })
})
