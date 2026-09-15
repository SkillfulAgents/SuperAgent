import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { agentCatalog, agentRegistry } from '@shared/lib/agent-actor'
import { createZipBuffer } from '@shared/lib/utils/zip'
import { createAgentFromExistingWorkspace } from './agent-service'
import { importAgentFromTemplate } from './agent-template-service'

const { stopContainer, getHealthWarnings } = vi.hoisted(() => ({
  stopContainer: vi.fn(async () => {}),
  getHealthWarnings: vi.fn(() => []),
}))
vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
      getCachedInfo: () => ({ status: 'stopped', port: null }),
      stopContainer,
      removeClient: vi.fn(),
      getHealthWarnings,
    }),
  }
})

let testDir: string
beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-rollback-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', testDir)
  vi.clearAllMocks()
})
afterEach(async () => {
  for (const slug of await agentCatalog.list()) agentRegistry.evict(slug)
  vi.unstubAllEnvs()
  fs.rmSync(testDir, { recursive: true, force: true })
})

const instructions = '---\nname: Import QA\n---\nInstructions.\n'

describe.each(['template', 'full'] as const)('failed %s import cleanup', (mode) => {
  it.each(['buffer', 'file'] as const)('removes the partial agent after a late filename failure from %s', async (source) => {
    const existing = await createAgentFromExistingWorkspace('Existing agent')
    const existingFile = path.join(testDir, 'agents', existing.slug, 'workspace', 'keep.txt')
    fs.writeFileSync(existingFile, 'KEEP_EXISTING_AGENT')
    const before = await agentCatalog.list()
    const zip = await createZipBuffer({
      'CLAUDE.md': instructions,
      'good.txt': 'EXTRACTED_BEFORE_FAILURE',
      ['x'.repeat(270) + '.txt']: 'invalid filename component',
    })
    const zipPath = path.join(testDir, 'upload.agent')
    fs.writeFileSync(zipPath, zip)

    await expect(importAgentFromTemplate(source === 'buffer' ? zip : { filePath: zipPath }, undefined, mode))
      .rejects.toThrow(/invalid path|ENAMETOOLONG/i)

    expect(await agentCatalog.list()).toEqual(before)
    expect(fs.readdirSync(path.join(testDir, 'agents'))).toEqual(before)
    expect(fs.readFileSync(existingFile, 'utf8')).toBe('KEEP_EXISTING_AGENT')
    expect(stopContainer).toHaveBeenCalledTimes(1)
    // The uploaded archive belongs to the caller, not rollback.
    expect(fs.readFileSync(zipPath)).toEqual(zip)
  })

  it('rolls back when finalizing the imported agent fails after extraction', async () => {
    getHealthWarnings.mockImplementationOnce(() => { throw new Error('finalization failed') })
    const zip = await createZipBuffer({ 'CLAUDE.md': instructions, 'good.txt': 'COMPLETE' })

    await expect(importAgentFromTemplate(zip, undefined, mode)).rejects.toThrow('finalization failed')

    expect(await agentCatalog.list()).toEqual([])
    expect(stopContainer).toHaveBeenCalledTimes(1)
  })

  it('reports rollback failure and preserves the workspace if the container cannot stop', async () => {
    stopContainer.mockRejectedValueOnce(new Error('container stop unavailable'))
    const zip = await createZipBuffer({
      'CLAUDE.md': instructions,
      'good.txt': 'PRESERVE_WHILE_CONTAINER_STATE_IS_UNKNOWN',
      ['x'.repeat(270) + '.txt']: 'invalid filename component',
    })

    await expect(importAgentFromTemplate(zip, undefined, mode)).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.objectContaining({ code: 'invalid-path' }), expect.objectContaining({ name: 'AgentContainerStopError' })],
      cause: expect.objectContaining({ code: 'invalid-path' }),
    })

    const slugs = await agentCatalog.list()
    expect(slugs).toHaveLength(1)
    expect(fs.readFileSync(path.join(testDir, 'agents', slugs[0], 'workspace', 'good.txt'), 'utf8'))
      .toBe('PRESERVE_WHILE_CONTAINER_STATE_IS_UNKNOWN')
  })

  it('keeps a successfully imported agent and its complete contents', async () => {
    const zip = await createZipBuffer({ 'CLAUDE.md': instructions, 'good.txt': 'COMPLETE' })
    const agent = await importAgentFromTemplate(zip, undefined, mode)
    expect(await agentCatalog.list()).toEqual([agent.slug])
    expect(fs.readFileSync(path.join(testDir, 'agents', agent.slug, 'workspace', 'good.txt'), 'utf8')).toBe('COMPLETE')
    expect(stopContainer).not.toHaveBeenCalled()
  })
})
