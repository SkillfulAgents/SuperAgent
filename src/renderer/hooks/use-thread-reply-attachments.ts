import { useCallback, useEffect, useRef } from 'react'
import { attachmentStatus, type Attachment } from '@renderer/components/messages/attachment-preview'
import { useUploadFile, useUploadFolder } from './use-messages'
import { useAttachments } from './use-attachments'
import { useUploadQueue } from './use-upload-queue'

/**
 * Files and folders for a thread reply: the session composer's attachments
 * (useAttachments) and upload queue, uploaded into the agent's workspace the
 * same way, without the composer's drive mounts. A reply carries them as the
 * attached-files block its text ends with, as a message does.
 */
export function useThreadReplyAttachments(agentSlug: string, sessionId: string) {
  const uploadFile = useUploadFile()
  const uploadFolder = useUploadFolder()
  const attachmentsRef = useRef<Attachment[]>([])
  const queueRef = useRef<ReturnType<typeof useUploadQueue> | null>(null)

  const {
    attachments,
    isDragOver,
    addFiles,
    updateAttachment,
    removeAttachment: removeAttachmentRaw,
    clearAttachments: clearAttachmentsRaw,
    handleFileSelect,
    handleFolderSelect,
    dragHandlers,
  } = useAttachments({
    onAttachmentsAdded: (added) => {
      for (const a of added) if (a.type === 'file' || a.type === 'folder') queueRef.current?.enqueue(a)
    },
  })
  attachmentsRef.current = attachments

  const queue = useUploadQueue({
    agentSlug,
    attachmentsRef,
    updateAttachment,
    removeAttachment: removeAttachmentRaw,
    clearAttachments: clearAttachmentsRaw,
    uploadFile: useCallback(
      ({ file, onProgress, signal, stallMs }) => uploadFile.mutateAsync({ sessionId, agentSlug, file, onProgress, signal, stallMs }),
      [uploadFile, sessionId, agentSlug],
    ),
    uploadFolder: useCallback(
      ({ sourcePath }) => uploadFolder.mutateAsync({ sessionId, agentSlug, sourcePath }),
      [uploadFolder, sessionId, agentSlug],
    ),
  })
  queueRef.current = queue

  // Leaving the thread drops what was attached but not sent.
  const clearOnLeave = queue.clear
  useEffect(() => () => clearOnLeave(), [clearOnLeave])

  const uploading = attachments.some((a) => {
    const status = attachmentStatus(a)
    return status === 'queued' || status === 'uploading'
  })
  const failed = attachments.some((a) => a.type !== 'mount' && !!a.error)

  /** The workspace paths of every finished upload, for the reply's attached-files block. */
  const uploadedPaths = useCallback(() => attachmentsRef.current.flatMap((a) => {
    if (a.type !== 'file' && a.type !== 'folder') return []
    const done = a.upload?.path ? { path: a.upload.path, agentSlug: a.upload.agentSlug } : queue.pathFor(a.id)
    return done?.path && done.agentSlug === agentSlug ? [done.path] : []
  }), [queue, agentSlug])

  return {
    attachments,
    isDragOver,
    dragHandlers,
    addFiles,
    handleFileSelect,
    handleFolderSelect,
    removeAttachment: queue.remove,
    retryAttachment: queue.retry,
    clearAttachments: queue.clear,
    uploading,
    failed,
    uploadedPaths,
  }
}
