import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createLocalFileOps } from '../agent-actor/local-file-ops'
import { MAX_TASK_ATTACHMENT_BYTES, taskReplySchema } from './attachment-schema'
import { stageTaskAttachments, readTaskAttachment, pruneTaskAttachments } from './attachments'
let dir: string
let workspace: string
const integrationId = crypto.randomUUID()
const publicationId = crypto.randomUUID()
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-attachment-files-'))
  workspace = path.join(dir, 'workspace'); await fs.mkdir(workspace)
  vi.stubEnv('SUPERAGENT_DATA_DIR', dir)
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(dir, { recursive: true, force: true }) })
function files() { return createLocalFileOps('agent', { getAgentWorkspaceDir: () => workspace }) }
describe('task attachment staging', () => {
  it('refuses traversal, host paths, outside symlinks and directories', async () => {
    await fs.writeFile(path.join(dir, 'secret'), 'private')
    await fs.symlink(path.join(dir, 'secret'), path.join(workspace, 'alias'))
    for (const file of ['../secret', '/etc/passwd', '/workspace/alias', '/workspace']) {
      await expect(stageTaskAttachments(integrationId, publicationId, files(), [{ path: file }], () => {})).rejects.toThrow()
    }
  })
  it('bounds both declared size and actual bytes if a file grows during reading', async () => {
    const actorFiles = files()
    const handle = await fs.open(path.join(workspace, 'huge.bin'), 'w')
    await handle.truncate(MAX_TASK_ATTACHMENT_BYTES + 1); await handle.close()
    await expect(stageTaskAttachments(integrationId, publicationId, actorFiles, [{ path: 'huge.bin' }], () => {})).rejects.toThrow('10 MiB')
    vi.spyOn(actorFiles, 'stat').mockResolvedValue({ kind: 'file', size: 1, mtimeMs: 0, mode: 0o600 })
    await expect(stageTaskAttachments(integrationId, publicationId, actorFiles, [{ path: 'huge.bin' }], () => {})).rejects.toThrow('10 MiB')
  })
  it('keeps immutable private snapshots and cleans only abandoned old publications', async () => {
    await fs.writeFile(path.join(workspace, 'chart.png'), 'image bytes')
    const draft = await stageTaskAttachments(integrationId, publicationId, files(), [{ path: '/workspace/chart.png', caption: 'Chart' }], () => {})
    await fs.writeFile(path.join(workspace, 'chart.png'), 'changed')
    expect((await readTaskAttachment(integrationId, publicationId, draft[0])).toString()).toBe('image bytes')
    const publicationDir = path.join(dir, 'integration-attachments', integrationId, publicationId)
    expect((await fs.stat(path.join(publicationDir, draft[0].id))).mode & 0o777).toBe(0o600)
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await fs.utimes(publicationDir, yesterday, yesterday)
    await pruneTaskAttachments(integrationId, new Set([publicationId]))
    expect((await readTaskAttachment(integrationId, publicationId, draft[0])).toString()).toBe('image bytes')
    await pruneTaskAttachments(integrationId, new Set())
    await expect(fs.stat(publicationDir)).rejects.toThrow()
  })
  it('does not accept model-supplied upload receipts or unsafe display names', () => {
    for (const attachment of [{ path: 'file', assetUrl: 'https://example.com' }, { path: 'file', filename: '../secret' }, { path: 'file', filename: 'a\nb' }]) {
      expect(taskReplySchema.safeParse({ body: 'Reply', attachments: [attachment] }).success).toBe(false)
    }
    expect(taskReplySchema.safeParse({ body: 'Reply', attachments: Array.from({ length: 6 }, () => ({ path: 'file' })) }).success).toBe(false)
  })
})
