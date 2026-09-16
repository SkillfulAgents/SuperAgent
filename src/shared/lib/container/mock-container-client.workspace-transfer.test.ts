import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getAgentWorkspaceDir } from '@shared/lib/utils/file-storage'
import { MockContainerClient } from './mock-container-client'

describe('MockContainerClient workspace transfer routes', () => {
  let dataDir: string
  let previousDataDir: string | undefined

  beforeEach(async () => {
    dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mock-workspace-transfer-'))
    previousDataDir = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = dataDir
    await fs.promises.mkdir(getAgentWorkspaceDir('agent-a'), { recursive: true })
  })

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = previousDataDir
    await fs.promises.rm(dataDir, { recursive: true, force: true })
  })

  it('uploads, streams, and deletes bytes through the production route shape', async () => {
    const client = new MockContainerClient({ agentId: 'agent-a' })
    const bytes = Uint8Array.from([0, 255, 1, 128])

    const upload = await client.fetch('/workspace-files/upload/uploads/x-agent/id/0/file.bin', {
      method: 'POST',
      body: bytes,
    })
    expect(upload.ok).toBe(true)

    const content = await client.fetch('/workspace-files/content/uploads/x-agent/id/0/file.bin')
    expect(content.ok).toBe(true)
    expect(Number(content.headers.get('Content-Length'))).toBe(bytes.length)
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes)

    const remove = await client.fetch('/workspace-files/delete/uploads/x-agent/id', { method: 'DELETE' })
    expect(remove.ok).toBe(true)
    await expect(fs.promises.stat(path.join(getAgentWorkspaceDir('agent-a'), 'uploads', 'x-agent', 'id')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })
})
