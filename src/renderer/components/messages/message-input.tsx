import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { getApiBaseUrl } from '@renderer/lib/env'
import { useSendMessage, useUploadFile, useUploadFolder, useInterruptSession } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { WifiOff } from 'lucide-react'
import { useIsOnline } from '@renderer/context/connectivity-context'
import { useUser } from '@renderer/context/user-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { UploadError } from '@renderer/components/ui/upload-error'
import { ComposerActionButton } from './composer-action-button'
import { SlashCommandMenu } from './slash-command-menu'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { ChatComposerBox } from './chat-composer-box'
import { ComposerOptions, useComposerOptions } from './composer-options'
import { useAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { useRenderTracker } from '@renderer/lib/perf'
import type { EffortLevel } from '@shared/lib/container/types'

interface MessageInputProps {
  sessionId: string
  agentSlug: string
  /** Called right before the POST so the caller can show the optimistic copy. `queued` is true when the agent is mid-turn. */
  onMessageSent?: (content: string, localId: string, queued: boolean) => void
  /** Called when the POST response arrives with the server-assigned message uuid. */
  onMessageUuidAssigned?: (localId: string, uuid: string, queued: boolean) => void
  /** Called when the POST fails, so the caller can drop the optimistic copy. */
  onMessageFailed?: (localId: string) => void
  /** Effort level last used on this session; seeds the composer selector. Defaults to 'high' when absent. */
  initialEffort?: EffortLevel
  /** Model last used on this session; seeds the composer selector. Defaults to provider's agent default. */
  initialModel?: string
}

export function MessageInput({ sessionId, agentSlug, onMessageSent, onMessageUuidAssigned, onMessageFailed, initialEffort, initialModel }: MessageInputProps) {
  useRenderTracker('MessageInput')
  const { canUseAgent, isAuthMode } = useUser()
  const isViewOnly = !canUseAgent(agentSlug)
  const lastTypingNotification = useRef(0)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashMenuIndex, setSlashMenuIndex] = useState(0)
  const { data: agentPrefs, isFetched: agentPrefsFetched } = useAgentPreferences(agentSlug)
  const composerOptions = useComposerOptions({
    initialEffort,
    initialModel,
    agentDefaultModel: agentPrefs?.defaultModel,
    agentDefaultEffort: agentPrefs?.defaultEffort,
    agentKey: agentSlug,
    agentDefaultsReady: agentPrefsFetched,
  })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sendMessage = useSendMessage()
  const uploadFile = useUploadFile()
  const uploadFolder = useUploadFolder()
  const interruptSession = useInterruptSession()
  const { isActive, slashCommands, isWaitingBackground } = useMessageStream(sessionId, agentSlug)
  const isOnline = useIsOnline()
  const isOffline = !isOnline
  const { track } = useAnalyticsTracking()
  // Block sends while the container runtime is still coming up (checking,
  // pulling image, unavailable). A message sent then has nothing to run it,
  // so the agent would silently drop it. `isPending` is the initial query
  // load — treat it as ready to avoid a disabled-input flash on mount.
  const { data: runtimeStatus, isPending: isRuntimePending } = useRuntimeStatus()
  const isRuntimeReady = isRuntimePending || runtimeStatus?.runtimeReadiness?.status === 'READY'

  const composer = useMessageComposer({
    agentSlug,
    uploadFile: useCallback(
      ({ file }) => uploadFile.mutateAsync({ sessionId, agentSlug, file }),
      [uploadFile, sessionId, agentSlug]
    ),
    uploadFolder: useCallback(
      ({ sourcePath }) => uploadFolder.mutateAsync({ sessionId, agentSlug, sourcePath }),
      [uploadFolder, sessionId, agentSlug]
    ),
    onSubmit: useCallback(async (content: string) => {
      // Local correlation id for the optimistic copy; the server-assigned
      // message uuid arrives with the POST response (the server always
      // generates it — a client-chosen id could forge attribution).
      const localId = crypto.randomUUID()
      // Mid-turn sends are queued by the agent loop (SDK streaming input) and
      // picked up after the current step. They must not carry model/effort —
      // a parameter change would interrupt/restart the in-flight query.
      // (The server also strips them when it sees the session is active.)
      const queued = isActive && !isWaitingBackground
      onMessageSent?.(content, localId, queued)
      try {
        const result = await sendMessage.mutateAsync({
          sessionId,
          agentSlug,
          content,
          ...(queued ? {} : composerOptions.toRuntimeOptions()),
        })
        // Reconcile against the server's authoritative decision: our local
        // `queued` guess is derived from SSE state that can be stale (reconnect,
        // a peer's turn, background-task flag), and a mismatch otherwise strands
        // the ghost — a server-queued message is re-id'd by the CLI, so it never
        // matches our uuid and never materializes.
        onMessageUuidAssigned?.(localId, result.uuid, result.queued)
      } catch (error) {
        onMessageFailed?.(localId)
        throw error
      }
      track('message_sent')
    }, [onMessageSent, onMessageUuidAssigned, onMessageFailed, sendMessage, sessionId, agentSlug, track, composerOptions, isActive, isWaitingBackground]),
    submitDisabled: sendMessage.isPending || isOffline || !isRuntimeReady,
    draftKey: `session:${sessionId}`,
  })

  // Extract the slash command prefix being typed (e.g. "co" from "/co")
  const slashFilter = useMemo(() => {
    const match = composer.message.match(/^\/(\S*)$/)
    return match ? match[1] : null
  }, [composer.message])

  // Filter slash commands based on current input
  const filteredCommands = useMemo(() => {
    if (!slashMenuOpen || slashCommands.length === 0 || slashFilter === null) return []
    const prefix = slashFilter.toLowerCase()
    return slashCommands.filter(cmd => cmd.name.toLowerCase().startsWith(prefix))
  }, [slashFilter, slashMenuOpen, slashCommands])

  // Clamp menu index when filtered list shrinks
  useEffect(() => {
    if (slashMenuIndex >= filteredCommands.length) {
      setSlashMenuIndex(Math.max(0, filteredCommands.length - 1))
    }
  }, [filteredCommands.length, slashMenuIndex])

  const selectSlashCommand = useCallback((name: string) => {
    composer.setMessage(`/${name} `)
    setSlashMenuOpen(false)
    textareaRef.current?.focus()
  }, [composer])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    composer.setMessage(value)

    // Open slash menu when input is "/" followed by optional non-space chars (still typing command)
    if (/^\/\S*$/.test(value) && slashCommands.length > 0) {
      setSlashMenuOpen(true)
      setSlashMenuIndex(0)
    } else {
      setSlashMenuOpen(false)
    }

    // Debounced typing notification for shared agents (auth mode)
    if (isAuthMode && value.length > 0) {
      const now = Date.now()
      if (now - lastTypingNotification.current > 3000) {
        lastTypingNotification.current = now
        fetch(`${getApiBaseUrl()}/api/agents/${agentSlug}/sessions/${sessionId}/typing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          credentials: 'include',
        }).catch(() => {})
      }
    }
  }, [composer, slashCommands.length, isAuthMode, agentSlug, sessionId])

  const handleInterrupt = async () => {
    if (interruptSession.isPending) return
    try {
      await interruptSession.mutateAsync({ sessionId, agentSlug })
    } catch (error) {
      console.error('Failed to interrupt session:', error)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash command menu keyboard navigation
    if (slashMenuOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashMenuIndex(i => (i + 1) % filteredCommands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashMenuIndex(i => (i - 1 + filteredCommands.length) % filteredCommands.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectSlashCommand(filteredCommands[slashMenuIndex].name)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashMenuOpen(false)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      // On touch (coarse pointer, no physical Shift key) Enter must insert a
      // newline — the user taps the Send button instead. Otherwise every Return,
      // including the keyboard's autocorrect-accept, would fire the message
      // mid-thought. Desktop (fine pointer) keeps Enter-to-send unchanged.
      if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) return
      e.preventDefault()
      composer.handleSubmit(e)
    }
  }

  const isDisabled = sendMessage.isPending || composer.isUploading || isOffline || !isRuntimeReady


  if (isViewOnly) {
    return null
  }

  return (
    <form
      onSubmit={composer.handleSubmit}
      className={`relative px-4 pt-3 ${composer.isDragOver ? 'ring-2 ring-primary ring-inset' : ''}`}
      {...composer.dragHandlers}
    >
      <MountChoiceDialog
        open={composer.mountDialog.open}
        onChoice={composer.mountDialog.onChoice}
        folderName={composer.mountDialog.folderName}
      />
      <SlashCommandMenu
        commands={filteredCommands}
        selectedIndex={slashMenuIndex}
        onSelect={selectSlashCommand}
        visible={slashMenuOpen}
        filter={slashFilter ?? ''}
      />
      <ChatComposerBox
        attachments={composer.attachments}
        onRemoveAttachment={composer.removeAttachment}
        textareaRef={textareaRef}
        value={composer.message}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={composer.handlePaste}
        onFocus={() => { if (slashFilter !== null && slashCommands.length > 0) setSlashMenuOpen(true) }}
        onBlur={() => setSlashMenuOpen(false)}
        placeholder={
          isOffline
            ? 'No internet connection...'
            : isActive
              ? 'Type your next message...'
              : 'Type a message...'
        }
        disabled={isDisabled}
        rows={2}
        enterKeyHint="enter"
        dataTestId="message-input"
        leftActions={(
          <>
            <AttachmentPicker
              onFileSelect={composer.handleFileSelect}
              onFolderSelect={composer.handleFolderSelect}
              onRecentFileAttach={(file) => composer.addFiles([{ file }])}
              disabled={isDisabled}
            />
            {/* Model/effort are locked while the agent works — changing them
                mid-turn would interrupt the running query. */}
            <ComposerOptions state={composerOptions} disabled={isDisabled || isActive} />
          </>
        )}
        rightActions={(
          <>
            <VoiceInputButton
              voiceInput={composer.voiceInput}
              message={composer.message}
              disabled={isDisabled}
            />
            <ComposerActionButton
              isActive={isActive}
              isWaitingBackground={isWaitingBackground}
              canSubmit={composer.canSubmit}
              isSending={sendMessage.isPending || composer.isUploading}
              isInterrupting={interruptSession.isPending}
              onInterrupt={handleInterrupt}
            />
          </>
        )}
        footer={(
          <>
            {isOffline && !isActive && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
                <WifiOff className="h-3 w-3 shrink-0" />
                <span>No internet connection. Messages cannot be sent.</span>
              </div>
            )}
            <VoiceInputError error={composer.voiceInput.error} onDismiss={composer.voiceInput.clearError} className="mt-2" />
            <UploadError error={composer.uploadError} onDismiss={composer.clearUploadError} className="mt-2" />
          </>
        )}
      />
    </form>
  )
}
