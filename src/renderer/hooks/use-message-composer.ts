import { useState, useCallback } from 'react'
import { useAttachments } from './use-attachments'
import { useVoiceInput } from './use-voice-input'
import { useAddMount } from './use-mounts'
import { appendAttachedFiles, appendMountedFolders } from '@shared/lib/utils/attached-files'
import { zipFolderFiles, type FolderGroup } from '@renderer/lib/file-utils'

interface UseMessageComposerOptions {
  agentSlug: string
  /** Upload a single file. Caller provides the right endpoint (session-level or agent-level). */
  uploadFile: (args: { file: File }) => Promise<{ path: string }>
  /** Upload a folder via Electron fs.cp. Caller provides the right endpoint. */
  uploadFolder: (args: { sourcePath: string }) => Promise<{ path: string }>
  /** Called after uploads complete and content is fully assembled. */
  onSubmit: (content: string) => Promise<void>
  /** Additional guard conditions that prevent submission (e.g. isActive, isOffline). */
  submitDisabled?: boolean
}

export function useMessageComposer(options: UseMessageComposerOptions) {
  const { agentSlug, onSubmit, submitDisabled } = options

  const [message, setMessage] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const addMountMutation = useAddMount()

  // Mount choice dialog state
  const [pendingFolders, setPendingFolders] = useState<FolderGroup[]>([])
  const [showMountDialog, setShowMountDialog] = useState(false)
  const isElectron = !!window.electronAPI

  const handleFoldersReceived = useCallback((folders: FolderGroup[]) => {
    setPendingFolders(folders)
    setShowMountDialog(true)
  }, [])

  const {
    attachments,
    isDragOver,
    addFiles,
    addFolders: addFoldersDirectly,
    addMounts,
    removeAttachment,
    clearAttachments,
    handleFileSelect,
    handleFolderSelect,
    dragHandlers,
  } = useAttachments({ onFoldersReceived: isElectron ? handleFoldersReceived : undefined })

  const voiceInput = useVoiceInput({
    onTranscriptUpdate: useCallback((text: string) => {
      setMessage(text)
    }, []),
  })

  const handleMountChoice = useCallback((choice: 'upload' | 'mount' | 'cancel') => {
    setShowMountDialog(false)
    if (choice === 'upload') {
      addFoldersDirectly(pendingFolders)
    } else if (choice === 'mount') {
      addMounts(pendingFolders.map((f) => ({
        folderName: f.folderName,
        hostPath: f.folderPath!,
      })))
    }
    setPendingFolders([])
  }, [pendingFolders, addFoldersDirectly, addMounts])

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return

    const pastedFiles: File[] = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) pastedFiles.push(file)
      }
    }

    if (pastedFiles.length > 0) {
      e.preventDefault()
      addFiles(pastedFiles.map((file) => ({ file })))
    }
  }, [addFiles])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Stop voice recording first — use returned text since React state won't update synchronously
    let voiceText: string | undefined
    if (voiceInput.isRecording || voiceInput.isConnecting) {
      voiceText = voiceInput.stopRecording()
    }

    const effectiveMessage = voiceText ?? message
    const hasContent = effectiveMessage.trim() || attachments.length > 0
    if (!hasContent || isUploading || submitDisabled) return

    let content = effectiveMessage.trim()

    // Upload attachments first
    if (attachments.length > 0) {
      setIsUploading(true)
      try {
        const uploadResults: { path: string }[] = []
        const mountResults: { containerPath: string; hostPath: string }[] = []

        for (const a of attachments) {
          if (a.type === 'mount') {
            const result = await addMountMutation.mutateAsync({ agentSlug, hostPath: a.hostPath, restart: true })
            mountResults.push({ containerPath: result.containerPath, hostPath: a.hostPath })
          } else if (a.type === 'folder' && a.folderPath) {
            // Electron: copy folder directly on the server filesystem
            const result = await options.uploadFolder({ sourcePath: a.folderPath })
            uploadResults.push(result)
          } else if (a.type === 'folder') {
            // Web fallback: zip files in browser and upload as single archive
            const zipBlob = await zipFolderFiles(a.files)
            const zipFile = new File([zipBlob], `${a.folderName}.zip`, { type: 'application/zip' })
            const result = await options.uploadFile({ file: zipFile })
            uploadResults.push(result)
          } else {
            const result = await options.uploadFile({ file: a.file })
            uploadResults.push(result)
          }
        }

        // Append mounts before files — parseAttachedFiles strips from its marker onward,
        // so [Attached files:] must come last for both blocks to be parseable.
        content = appendMountedFolders(content, mountResults)
        content = appendAttachedFiles(content, uploadResults.map((r) => r.path))
      } catch (error) {
        console.error('Failed to upload attachments:', error)
        setIsUploading(false)
        return
      }
      setIsUploading(false)
    }

    // Clear input immediately so the message doesn't linger while the network request is in flight
    setMessage('')
    clearAttachments()

    try {
      await onSubmit(content)
    } catch (error) {
      console.error('Failed to submit:', error)
      // Restore message so the user doesn't lose their text
      setMessage(content)
      return
    }
  }

  const canSubmit = (!!message.trim() || attachments.length > 0 || voiceInput.isRecording) && !isUploading && !submitDisabled

  return {
    // Message state
    message,
    setMessage,

    // Attachments
    attachments,
    isDragOver,
    removeAttachment,
    handleFileSelect,
    handleFolderSelect,
    dragHandlers,

    // Voice
    voiceInput,

    // Mount dialog
    mountDialog: {
      open: showMountDialog,
      onChoice: handleMountChoice,
      folderName: pendingFolders.length === 1 ? pendingFolders[0].folderName : undefined,
    },

    // Submit
    isUploading,
    handleSubmit,
    handlePaste,
    canSubmit,
  }
}
