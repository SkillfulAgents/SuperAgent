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

/**
 * The body, failed once it carries more or fewer bytes than its size said.
 * `failure` is that failure, on this side: whoever reads the body (another
 * agent's write) reports it in its own terms.
 */
function countedBody(
  body: ReadableStream<Uint8Array>,
  expectedBytes: number,
  sourcePath: string,
): { body: ReadableStream<Uint8Array>; failure: () => XAgentAttachmentError | undefined } {
  let received = 0
  let failure: XAgentAttachmentError | undefined
  const changed = () => (failure = new XAgentAttachmentError(`Attachment changed while being read: ${sourcePath}`, 409))
  return {
    body: body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > expectedBytes || received > MAX_X_AGENT_ATTACHMENT_BYTES) {
          controller.error(changed())
          return
        }
        controller.enqueue(chunk)
      },
      flush() {
        if (received !== expectedBytes) throw changed()
      },
    })),
    failure: () => failure,
  }
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
export async function openXAgentFile(
  files: FileOps,
  filePath: string,
): Promise<{ sizeBytes: number; body: ReadableStream<Uint8Array>; failure: () => XAgentAttachmentError | undefined }> {
  let opened: { size: number; stream: ReadableStream<Uint8Array> }
  try {
    opened = await files.readSized(filePath, { confined: true })
  } catch (error) {
    throw transferError(error)
  }
  const { size: sizeBytes, stream } = opened
  try {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new XAgentAttachmentError('File size is unavailable', 502)
    if (sizeBytes > MAX_X_AGENT_ATTACHMENT_BYTES) throw new XAgentAttachmentError('File exceeds the transfer limit', 413)
  } catch (error) {
    await stream.cancel().catch(() => {})
    throw error
  }
  if (sizeBytes === 0) return { sizeBytes, body: stream, failure: () => undefined }
  return { sizeBytes, ...countedBody(stream, sizeBytes, filePath) }
}

/** The stream, failed once the signal aborts: the write it feeds then discards what it staged. */
function abortable(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  if (!signal) return body
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal })
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
      const { sizeBytes, body, failure } = await openXAgentFile(input.sourceFiles, sourcePath)
      totalBytes += sizeBytes
      if (totalBytes > MAX_X_AGENT_ATTACHMENTS_TOTAL_BYTES) {
        await body.cancel()
        throw new XAgentAttachmentError('Attachments exceed the aggregate transfer limit', 413)
      }
      const filename = sanitizeUploadFilename(path.posix.basename(sourcePath))
      const targetPath = `${targetDirectory}/${index}/${filename}`
      try {
        await input.targetFiles.write(targetPath, abortable(body, input.signal), { confined: true, overwrite: false })
      } catch (error) {
        // A refused destination may not have consumed the source yet.
        if (!body.locked) await body.cancel().catch(() => {})
        // The source changed under the read: that is the failure, whatever the write made of it.
        throw failure() ?? error
      }
      attachments.push({ sourcePath, targetPath, sizeBytes })
    }
    return { attachments, targetDirectory }
  } catch (error) {
    await removeTransferredAttachments(input.targetFiles, targetDirectory).catch(() => {})
    throw transferError(error)
  }
}
