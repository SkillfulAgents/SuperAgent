import { randomUUID } from 'crypto'
import path from 'path'
import type { ContainerClient } from '@shared/lib/container/types'
import { sanitizeUploadFilename } from '@shared/lib/utils/path-safety'
import {
  MAX_X_AGENT_ATTACHMENT_BYTES,
  MAX_X_AGENT_ATTACHMENTS_TOTAL_BYTES,
  xAgentAttachmentErrorResponseSchema,
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

export function xAgentWorkspaceFileRoute(filePath: string, operation: 'content' | 'upload' | 'delete'): string {
  const relative = path.posix.relative(WORKSPACE_ROOT, filePath)
  const encoded = relative.split('/').map(encodeURIComponent).join('/')
  return `/workspace-files/${operation}/${encoded}`
}

function parseContentLength(response: Response, sourcePath: string): number {
  const raw = response.headers.get('Content-Length')
  const size = Number(raw)
  if (!raw || !Number.isSafeInteger(size) || size < 0) {
    throw new XAgentAttachmentError(`Could not determine attachment size: ${sourcePath}`, 502)
  }
  if (size > MAX_X_AGENT_ATTACHMENT_BYTES) {
    throw new XAgentAttachmentError(`Attachment exceeds the ${MAX_X_AGENT_ATTACHMENT_BYTES}-byte limit: ${sourcePath}`, 413)
  }
  return size
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

async function responseError(response: Response, fallback: string): Promise<XAgentAttachmentError> {
  let detail = fallback
  try {
    const parsed = xAgentAttachmentErrorResponseSchema.safeParse(await response.json())
    if (parsed.success && parsed.data.error) detail = parsed.data.error
  } catch {
    // Binary/non-JSON failures use the scoped fallback.
  }
  const status = response.status === 400 || response.status === 403 || response.status === 404 ||
    response.status === 409 || response.status === 413
    ? response.status
    : 502
  return new XAgentAttachmentError(detail, status)
}

export function normalizeXAgentAttachmentPaths(paths: string[]): string[] {
  return xAgentAttachmentsSchema.parse(paths).map(normalizeSourcePath)
}

export async function removeTransferredAttachments(
  targetClient: ContainerClient,
  targetDirectory: string,
): Promise<void> {
  const response = await targetClient.fetch(xAgentWorkspaceFileRoute(targetDirectory, 'delete'), { method: 'DELETE' })
  if (!response.ok && response.status !== 404) {
    throw await responseError(response, 'Could not remove transferred attachments')
  }
}

export async function transferXAgentAttachments(input: {
  sourceClient: ContainerClient
  targetClient: ContainerClient
  sourcePaths: string[]
  signal?: AbortSignal
  transferId?: string
}): Promise<{ attachments: TransferredXAgentAttachment[]; targetDirectory?: string }> {
  const sourcePaths = normalizeXAgentAttachmentPaths(input.sourcePaths)
  if (sourcePaths.length === 0) return { attachments: [] }

  const transferId = input.transferId ?? randomUUID()
  const targetDirectory = `${WORKSPACE_ROOT}/uploads/x-agent/${transferId}`
  const attachments: TransferredXAgentAttachment[] = []
  let totalBytes = 0

  try {
    for (const [index, sourcePath] of sourcePaths.entries()) {
      const sourceResponse = await input.sourceClient.fetch(
        xAgentWorkspaceFileRoute(sourcePath, 'content'),
        { signal: input.signal },
      )
      if (!sourceResponse.ok) {
        throw await responseError(sourceResponse, `Could not read attachment: ${sourcePath}`)
      }

      let sizeBytes: number
      try {
        sizeBytes = parseContentLength(sourceResponse, sourcePath)
      } catch (error) {
        await sourceResponse.body?.cancel().catch(() => {})
        throw error
      }
      totalBytes += sizeBytes
      if (totalBytes > MAX_X_AGENT_ATTACHMENTS_TOTAL_BYTES) {
        await sourceResponse.body?.cancel()
        throw new XAgentAttachmentError(
          `Attachments exceed the ${MAX_X_AGENT_ATTACHMENTS_TOTAL_BYTES}-byte aggregate limit`,
          413,
        )
      }

      const filename = sanitizeUploadFilename(path.posix.basename(sourcePath))
      const targetPath = `${targetDirectory}/${index}/${filename}`
      const body = countedBody(sourceResponse.body, sizeBytes, sourcePath)
      const uploadResponse = await input.targetClient.fetch(
        xAgentWorkspaceFileRoute(targetPath, 'upload'),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(sizeBytes),
          },
          body,
          signal: input.signal,
          duplex: 'half',
        } as RequestInit & { duplex: 'half' },
      )
      if (!uploadResponse.ok) {
        throw await responseError(uploadResponse, `Could not write attachment: ${filename}`)
      }
      attachments.push({ sourcePath, targetPath, sizeBytes })
    }
    return { attachments, targetDirectory }
  } catch (error) {
    await removeTransferredAttachments(input.targetClient, targetDirectory).catch(() => {})
    throw error
  }
}
