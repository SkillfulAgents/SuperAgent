import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { FileOps } from '../agent-actor/types'
import { workspaceBasename } from '../agent-actor/workspace-path'
import { getDataDir } from '../config/data-dir'
import { guessMimeType } from '../utils/mime'
import { MAX_TASK_ATTACHMENT_BYTES, taskAttachmentSchema, taskReplySchema, type TaskAttachment, type TaskReplyAttachment } from './attachment-schema'

function directory(integrationId: string, publicationId?: string): string {
  // Only host-generated UUIDs can address this private spool, never tool paths.
  return path.join(getDataDir(), 'integration-attachments', z.uuid().parse(integrationId), ...(publicationId ? [z.uuid().parse(publicationId)] : []))
}

/** Snapshot before saving the reply: later workspace edits cannot change retries. */
export async function stageTaskAttachments(integrationId: string, publicationId: string, files: FileOps,
  inputs: TaskReplyAttachment[], assertActive: () => void): Promise<TaskAttachment[]> {
  const attachments: TaskAttachment[] = []
  const validated = taskReplySchema.shape.attachments.parse(inputs) ?? []
  try {
    for (const input of validated) {
      assertActive()
      // resolve rejects symlinks outside the workspace as well as lexical traversal.
      const resolved = await files.resolve(input.path)
      const stat = resolved === null ? null : await files.stat(resolved)
      if (resolved === null || !stat || stat.kind !== 'file') throw new Error(`Attachment is not an existing workspace file: ${input.path}`)
      if (stat.size > MAX_TASK_ATTACHMENT_BYTES) throw new Error('Each attachment must be at most 10 MiB')
      const reader = (await files.read(resolved)).getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          const value = chunk.value
          assertActive()
          size += value.byteLength
          if (size > MAX_TASK_ATTACHMENT_BYTES) throw new Error('Each attachment must be at most 10 MiB')
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      const attachment = taskAttachmentSchema.parse({ id: crypto.randomUUID(), filename: input.filename ?? workspaceBasename(input.path),
        caption: input.caption, contentType: guessMimeType(input.path), size })
      const dir = directory(integrationId, publicationId)
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      const file = await fs.open(path.join(dir, attachment.id), 'wx', 0o600)
      try { await file.writeFile(Buffer.concat(chunks, size)); await file.sync() } finally { await file.close() }
      assertActive()
      attachments.push(attachment)
    }
    return attachments
  } catch (error) {
    await removeTaskAttachments(integrationId, publicationId).catch(() => {})
    throw error
  }
}

export async function readTaskAttachment(integrationId: string, publicationId: string, input: TaskAttachment): Promise<Buffer> {
  const attachment = taskAttachmentSchema.parse(input)
  const bytes = await fs.readFile(path.join(directory(integrationId, publicationId), attachment.id))
  if (bytes.length !== attachment.size) throw new Error('Staged attachment size changed')
  return bytes
}

export async function removeTaskAttachments(integrationId: string, publicationId?: string): Promise<void> {
  await fs.rm(directory(integrationId, publicationId), { recursive: true, force: true })
}

/** Clean crash leftovers without touching pending drafts or in-flight staging. */
export async function pruneTaskAttachments(integrationId: string, pendingPublicationIds: Set<string>): Promise<void> {
  const dir = directory(integrationId)
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success || pendingPublicationIds.has(entry.name)) continue
    const stat = await fs.stat(path.join(dir, entry.name))
    if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) await removeTaskAttachments(integrationId, entry.name)
  }
}
