import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { captureRendererException } from '@renderer/lib/error-reporting'
import { useAttachments } from './use-attachments'
import { useVoiceInput } from './use-voice-input'
import { useAddMount } from './use-mounts'
import { useDraft } from '@renderer/context/drafts-context'
import { appendAttachedFiles, appendMountedFolders } from '@shared/lib/utils/attached-files'
import { zipFolderFiles, type FolderGroup } from '@renderer/lib/file-utils'
import type { Attachment } from '@renderer/components/messages/attachment-preview'
import {
  findPotentialSecrets,
  replaceSecuredSecrets,
  secretDisplayText,
  type PotentialSecret,
  type SecuredSecret,
} from '@renderer/lib/secret-detection'

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
  /** When true, keep the message in the input until onSubmit resolves (useful when there's a navigation delay). Defaults to false. */
  keepMessageUntilComplete?: boolean
  /** If provided, the composer persists its draft under this key via DraftsContext so it survives unmount. */
  draftKey?: string
  /** One-shot attachment seed, used when moving a draft into a new session. */
  initialAttachments?: Attachment[]
  /** One-shot secure-pill seed, used when moving a draft into a new session. */
  initialSecuredSecrets?: SecuredSecret[]
}

export function useMessageComposer(options: UseMessageComposerOptions) {
  const { agentSlug, onSubmit, submitDisabled, keepMessageUntilComplete, draftKey } = options

  const [draft, setDraft] = useDraft<string>(draftKey)
  const securedDraftKey = draftKey ? `${draftKey}:secured-secrets` : undefined
  const [draftSecuredSecrets, setDraftSecuredSecrets] = useDraft<SecuredSecret[]>(securedDraftKey)
  const [message, setMessage] = useState(draft ?? '')
  const [dismissedSecretValues, setDismissedSecretValues] = useState<Set<string>>(() => new Set())
  const [securedSecrets, setSecuredSecrets] = useState<SecuredSecret[]>(
    () => options.initialSecuredSecrets ?? draftSecuredSecrets ?? []
  )
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const addMountMutation = useAddMount()

  // Persist local message to the draft store so it survives unmount. Skip the
  // initial commit: the store is already the source of truth at mount, and
  // writing the default-empty message here would clobber a draft that a sibling
  // effect may have just written under the same key.
  const persistedOnceRef = useRef(false)
  useEffect(() => {
    if (!persistedOnceRef.current) {
      persistedOnceRef.current = true
      return
    }
    setDraft(message || undefined)
  }, [message, setDraft])

  useEffect(() => {
    setDraftSecuredSecrets(securedSecrets.length > 0 ? securedSecrets : undefined)
  }, [securedSecrets, setDraftSecuredSecrets])

  // Sync externally-injected drafts (e.g. voice feedback) into the local message.
  useEffect(() => {
    if (draft !== undefined && draft !== message) {
      setMessage(draft)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to external draft changes
  }, [draft])

  // A dismissal lasts while that exact value remains in the draft. Removing it
  // and pasting/typing it again is treated as a fresh safety signal.
  useEffect(() => {
    setDismissedSecretValues((current) => {
      const next = new Set([...current].filter((value) => message.includes(value)))
      if (next.size === current.size) return current
      return next
    })
  }, [message])

  const potentialSecrets = useMemo(
    () => findPotentialSecrets(message).filter((candidate) => !dismissedSecretValues.has(candidate.value)),
    [message, dismissedSecretValues]
  )

  const dismissPotentialSecret = useCallback((candidate: PotentialSecret) => {
    setDismissedSecretValues((current) => {
      const next = new Set(current)
      next.add(candidate.value)
      return next
    })
  }, [])

  const securePotentialSecret = useCallback((
    candidate: PotentialSecret,
    savedSecret: { key: string; envVar: string }
  ) => {
    setMessage((current) => {
      if (current.slice(candidate.start, candidate.end) !== candidate.value) return current
      const displayText = secretDisplayText(savedSecret.key)
      const securedSecret: SecuredSecret = {
        id: `${candidate.id}:${savedSecret.envVar}`,
        key: savedSecret.key,
        envVar: savedSecret.envVar,
        displayText,
      }
      setSecuredSecrets((existing) => [...existing, securedSecret])
      return `${current.slice(0, candidate.start)}${displayText}${current.slice(candidate.end)}`
    })
  }, [])

  const removeSecuredSecrets = useCallback((
    secrets: SecuredSecret[],
    range: { start: number; end: number }
  ) => {
    const secretIds = new Set(secrets.map((secret) => secret.id))
    setMessage((current) => `${current.slice(0, range.start)}${current.slice(range.end)}`)
    setSecuredSecrets((current) => current.filter((secret) => !secretIds.has(secret.id)))
  }, [])

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
    setAttachmentError,
    clearAttachmentErrors,
    removeAttachment,
    clearAttachments,
    handleFileSelect,
    handleFolderSelect,
    dragHandlers,
  } = useAttachments({
    onFoldersReceived: isElectron ? handleFoldersReceived : undefined,
    initialAttachments: options.initialAttachments,
  })

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
      // A folder without a resolved absolute path can't be mounted — fall back
      // to upload for it rather than POSTing a mount with no hostPath.
      const mountable = pendingFolders.filter((f) => f.folderPath)
      const pathless = pendingFolders.filter((f) => !f.folderPath)
      addMounts(mountable.map((f) => ({
        folderName: f.folderName,
        hostPath: f.folderPath!,
      })))
      if (pathless.length > 0) {
        addFoldersDirectly(pathless)
      }
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

    // Stop voice recording first and await the final text: stopRecording flushes
    // buffered audio and waits for the server's trailing transcripts, so a quick
    // speak-then-Enter doesn't submit before the dictated words are in.
    let voiceText: string | undefined
    if (voiceInput.isRecording || voiceInput.isConnecting) {
      voiceText = await voiceInput.stopRecording()
    }

    const effectiveMessage = voiceText ?? message
    const hasContent = effectiveMessage.trim() || attachments.length > 0
    if (!hasContent || isUploading || submitDisabled) return

    let content = effectiveMessage.trim()

    // Upload attachments first
    if (attachments.length > 0) {
      setIsUploading(true)
      setUploadError(null)
      clearAttachmentErrors()
      // Tracks the attachment being processed so the catch can flag its chip
      let inFlightAttachment: Attachment | null = null
      try {
        const uploadResults: { path: string }[] = []
        const mountResults: { containerPath: string; hostPath: string }[] = []

        for (const a of attachments) {
          inFlightAttachment = a
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
        captureRendererException(error, { tags: { source: 'attachment-upload' }, extra: { agentSlug } })
        const message = error instanceof Error ? error.message : 'Upload failed. Please try again.'
        if (inFlightAttachment) {
          setAttachmentError(inFlightAttachment.id, message)
        }
        setUploadError(message)
        setIsUploading(false)
        return
      }
      setIsUploading(false)
    }

    if (!keepMessageUntilComplete) {
      // Clear input immediately so the message doesn't linger while the network request is in flight
      setMessage('')
      setDraft(undefined)
      clearAttachments()
    }

    const editableContent = content
    const submittedContent = replaceSecuredSecrets(content, securedSecrets)

    try {
      await onSubmit(submittedContent)
    } catch (error) {
      console.error('Failed to submit:', error)
      if (!keepMessageUntilComplete) {
        // Restore message so the user doesn't lose their text
        setMessage(editableContent)
      }
      return
    }

    if (keepMessageUntilComplete) {
      setMessage('')
      setDraft(undefined)
      clearAttachments()
    }
    setSecuredSecrets([])
  }

  const canSubmit = (!!message.trim() || attachments.length > 0 || voiceInput.isRecording) && !isUploading && !submitDisabled

  return {
    // Message state
    message,
    setMessage,
    potentialSecrets,
    securedSecrets,
    dismissPotentialSecret,
    securePotentialSecret,
    removeSecuredSecrets,

    // Attachments
    attachments,
    isDragOver,
    addFiles,
    removeAttachment,
    clearAttachments,
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

    // Upload error (surfaced to the user; cleared on next submit attempt)
    uploadError,
    clearUploadError: useCallback(() => setUploadError(null), []),
  }
}
