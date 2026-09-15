import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROJECTS_DIR, TranscriptMirror } from './modal-transcript-mirror'
import { ModalVolumeFiles } from '@shared/lib/container/modal/modal-volume'
import { FakeVolumeControlPlane } from '@shared/lib/container/modal/testing/fake-volume-control-plane'

const text = (s: string) => new TextEncoder().encode(s)
const PROJECT = '---modal-volumes-vo-abc123'

describe('TranscriptMirror', () => {
  let dir: string
  let fake: FakeVolumeControlPlane
  let volume: ModalVolumeFiles
  let mirror: TranscriptMirror

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-mirror-'))
    fake = new FakeVolumeControlPlane()
    volume = await ModalVolumeFiles.ensure('fake', fake.deps)
    mirror = new TranscriptMirror('agent', async () => volume, () => dir)
  })

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  it('copies every project directory on the volume into the one local transcripts directory', async () => {
    await volume.put(`${PROJECTS_DIR}/${PROJECT}/s1.jsonl`, text('{"a":1}\n'))
    await volume.put(`${PROJECTS_DIR}/${PROJECT}/s1/subagents/sub.jsonl`, text('{"b":2}\n'))

    await mirror.sync()
    expect(await fs.promises.readFile(path.join(dir, 's1.jsonl'), 'utf-8')).toBe('{"a":1}\n')
    expect(await fs.promises.readFile(path.join(dir, 's1', 'subagents', 'sub.jsonl'), 'utf-8')).toBe('{"b":2}\n')
  })

  it('an unchanged volume costs one listing and no downloads; a grown transcript is fetched again', async () => {
    await volume.put(`${PROJECTS_DIR}/${PROJECT}/s1.jsonl`, text('line1\n'))
    await mirror.sync()
    fake.calls.length = 0

    // Within the quiet interval the pass is skipped outright.
    await mirror.sync()
    expect(fake.calls).toEqual([])

    await new Promise((resolve) => setTimeout(resolve, 800))
    await mirror.sync()
    expect(fake.calls).toEqual(['volumeListFiles2'])

    await volume.put(`${PROJECTS_DIR}/${PROJECT}/s1.jsonl`, text('line1\nline2\n'))
    fake.calls.length = 0
    await new Promise((resolve) => setTimeout(resolve, 800))
    await mirror.sync()
    expect(fake.calls.filter((call) => call === 'volumeGetFile2')).toHaveLength(1)
    expect(await fs.promises.readFile(path.join(dir, 's1.jsonl'), 'utf-8')).toBe('line1\nline2\n')
  })

  it('a file gone from the volume is removed locally, and removeSession removes the volume copies', async () => {
    await volume.put(`${PROJECTS_DIR}/${PROJECT}/s1.jsonl`, text('1'))
    await volume.put(`${PROJECTS_DIR}/${PROJECT}/s1/subagents/sub.jsonl`, text('2'))
    await volume.put(`${PROJECTS_DIR}/${PROJECT}/s2.jsonl`, text('3'))
    await mirror.sync()

    await volume.remove(`${PROJECTS_DIR}/${PROJECT}/s2.jsonl`)
    await new Promise((resolve) => setTimeout(resolve, 800))
    await mirror.sync()
    expect(await fs.promises.stat(path.join(dir, 's2.jsonl')).catch(() => null)).toBeNull()

    await mirror.removeSession('s1')
    expect(fake.files.has(`${PROJECTS_DIR}/${PROJECT}/s1.jsonl`)).toBe(false)
    expect(fake.files.has(`${PROJECTS_DIR}/${PROJECT}/s1/subagents/sub.jsonl`)).toBe(false)
    // A session with nothing on the volume is fine.
    await expect(mirror.removeSession('never')).resolves.toBeUndefined()
  })

  it('an agent with no transcripts yet syncs to an empty directory without error', async () => {
    await expect(mirror.sync()).resolves.toBeUndefined()
  })
})
