import { randomUUID } from 'crypto'
import path from 'path'
import type { FileOps } from '@shared/lib/agent-actor/types'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { sanitizeUploadFilename } from '@shared/lib/utils/path-safety'
import {
  MAX_X_AGENT_ATTACHMENT_BYTES,
  MAX_X_AGENT_ATTACHMENTS_TOTAL_BYTES,
  xAgentAttachmentsSchema,
} from './x-agent-attachment-schema'

const WORKSPACE_ROOT = '/workspace'

export interface TransferredXAgentAttachment {
  sourcePath: string
  targetPath: string
  sizeBytes: number
}

export class XAgentAttachmentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 500 | 502 | 504 = 400,
  ) {
    super(message)
    this.name = 'XAgentAttachmentError'
  }
}

function normalizeSourcePath(rawPath: string): string {
  if (rawPath.includes('\0')) {
    throw new XAgentAttachmentError('Attachment path contains a NUL byte')
  }
  const slashPath = rawPath.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(slashPath)) {
    throw new XAgentAttachmentError('Attachment path must be inside /workspace')
  }
  const rawSegments = slashPath.split('/')
  if (rawSegments.includes('..')) {
    throw new XAgentAttachmentError('Attachment path traversal is not allowed')
  }

  const absolute = path.posix.isAbsolute(slashPath)
    ? path.posix.normalize(slashPath)
    : path.posix.join(WORKSPACE_ROOT, slashPath)
  const relative = path.posix.relative(WORKSPACE_ROOT, absolute)
  if (!relative || relative === '.' || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new XAgentAttachmentError('Attachment path must name a file inside /workspace')
  }
  return path.posix.join(WORKSPACE_ROOT, relative)
}

function countedBody(
  body: ReadableStream<Uint8Array> | null,
  expectedBytes: number,
  sourcePath: string,
): ReadableStream<Uint8Array> {
  if (!body) {
    if (expectedBytes === 0) return new ReadableStream({ start: (controller) => controller.close() })
    throw new XAgentAttachmentError(`Attachment response had no body: ${sourcePath}`, 502)
  }
  let received = 0
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength
      if (received > expectedBytes || received > MAX_X_AGENT_ATTACHMENT_BYTES) {
        controller.error(new XAgentAttachmentError(`Attachment changed while being read: ${sourcePath}`, 409))
        return
      }
      controller.enqueue(chunk)
    },
    flush() {
      if (received !== expectedBytes) {
        throw new XAgentAttachmentError(`Attachment changed while being read: ${sourcePath}`, 409)
      }
    },
  }))
}

/** Preserve typed transfer errors even when a lower-level stream wraps its cause. */
export function transferError(error: unknown): unknown {
  const seen = new Set<unknown>()
  for (let current = error; current && !seen.has(current); current = (current as Error).cause) {
    seen.add(current)
    if (current instanceof XAgentAttachmentError) return current
    if (current instanceof WorkspaceFileError) return new XAgentAttachmentError(current.message, current.status)
  }
  return error
}

/** Read size and bounded bytes from the same confined open file. */
export async function openXAgentFile(files: FileOps, filePath: string): Promise<{ sizeBytes: number; body: ReadableStream<Uint8Array> }> {
  const file = await files.open(filePath, { confined: true })
  try {
    const sizeBytes = await file.size()
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new XAgentAttachmentError('File size is unavailable', 502)
    if (sizeBytes > MAX_X_AGENT_ATTACHMENT_BYTES) throw new XAgentAttachmentError('File exceeds the transfer limit', 413)
    if (sizeBytes === 0) {
      await file.close()
      return { sizeBytes, body: new ReadableStream({ start: (controller) => controller.close() }) }
    }
    return { sizeBytes, body: countedBody(file.stream({ start: 0, end: sizeBytes - 1 }), sizeBytes, filePath) }
  } catch (error) {
    await file.close().catch(() => {})
    throw transferError(error)
  }
}

export function normalizeXAgentAttachmentPaths(paths: string[]): string[] {
  return xAgentAttachmentsSchema.parse(paths).map(normalizeSourcePath)
}

export async function removeTransferredAttachments(files: FileOps, targetDirectory: string): Promise<void> {
  await files.delete(targetDirectory, { recursive: true, confined: true })
}

export async function transferXAgentAttachments(input: {
  sourceFiles: FileOps
  targetFiles: FileOps
  sourcePaths: string[]
  signal?: AbortSignal
  transferId?: string
}): Promise<{ attachments: TransferredXAgentAttachment[]; targetDirectory?: string }> {
  const sourcePaths = normalizeXAgentAttachmentPaths(input.sourcePaths)
  if (sourcePaths.length === 0) return { attachments: [] }
  const targetDirectory = `${WORKSPACE_ROOT}/uploads/x-agent/${input.transferId ?? randomUUID()}`
  const attachments: TransferredXAgentAttachment[] = []
  let totalBytes = 0
  try {
    for (const [index, sourcePath] of sourcePaths.entries()) {
      input.signal?.throwIfAborted()
      const { sizeBytes, body } = await openXAgentFile(input.sourceFiles, sourcePath)
      totalBytes += sizeBytes
      if (totalBytes > MAX_X_AGENT_ATTACHMENTS_TOTAL_BYTES) {
        await body.cancel()
        throw new XAgentAttachmentError('Attachments exceed the aggregate transfer limit', 413)
      }
      const filename = sanitizeUploadFilename(path.posix.basename(sourcePath))
      const targetPath = `${targetDirectory}/${index}/${filename}`
      try {
        await input.targetFiles.write(targetPath, body, { confined: true, overwrite: false, signal: input.signal })
      } catch (error) {
        // A refused destination may not have consumed the source yet.
        if (!body.locked) await body.cancel().catch(() => {})
        throw error
      }
      attachments.push({ sourcePath, targetPath, sizeBytes })
    }
    return { attachments, targetDirectory }
  } catch (error) {
    await removeTransferredAttachments(input.targetFiles, targetDirectory).catch(() => {})
    throw transferError(error)
  }
}
