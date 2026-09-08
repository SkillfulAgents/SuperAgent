import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { getApiBaseUrl } from '@renderer/lib/env'
import { useMessages, useSendMessage, useUploadFile, useUploadFolder, useInterruptSession } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { labelBackgroundTasks } from '@renderer/lib/background-task-label'
import { StopSessionDialog } from './stop-session-dialog'
import { WifiOff } from 'lucide-react'
import { useIsOnline } from '@renderer/context/connectivity-context'
import { useUser } from '@renderer/context/user-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { VoiceModeButton } from '@renderer/components/ui/voice-mode-button'
import { VoiceModeComposer } from './voice-mode-composer'
import { VoiceModeControls, useHoldSoundPreference } from './voice-mode-controls'
import { useVoiceMode } from '@renderer/hooks/use-voice-mode'
import { useHoldSound } from '@renderer/hooks/use-hold-sound'
import { readAloud } from '@renderer/hooks/use-read-aloud'
import { clearVoiceModeRequest, isVoiceModeRequested, setVoiceModeActive } from '@renderer/lib/voice-mode-handoff'
import { VOICE_MODE_ENTERED_MESSAGE, VOICE_MODE_EXITED_MESSAGE } from '@shared/lib/voice/voice-mode-messages'
import { UploadError } from '@renderer/components/ui/upload-error'
import { ComposerActionButton } from './composer-action-button'
import { SlashCommandMenu } from './slash-command-menu'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import { registerSessionComposerFocus } from './composer-focus'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { ChatComposerBox, FLOATING_COMPOSER_CLASS } from './chat-composer-box'
import { ComposerOptions, useComposerOptions } from './composer-options'
import { AgentDefaultFooter } from './agent-default-footer'
import { useAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { useRenderTracker } from '@renderer/lib/perf'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'
import type { ComposerSnapshot } from '@renderer/lib/new-session-carryover'

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
  /** Speed last used on this session; seeds the composer selector. Defaults to 'normal' when absent. */
  initialSpeed?: SpeedLevel
  /** Model last used on this session; seeds the composer selector. Defaults to provider's agent default. */
  initialModel?: string
  /** Registers a getter so the stale-session prompt can move the live draft. */
  registerSnapshot?: (getSnapshot: (() => ComposerSnapshot) | null) => void
  /**
   * Hidden behind a request card the agent is waiting on. Voice mode pauses
   * (mic closed, the reply being read finishes, no hold sound) and resumes
   * when the card is gone, rather than ending, so the agent is not told the
   * person left.
   */
  suspended?: boolean
}

export function MessageInput({ sessionId, agentSlug, onMessageSent, onMessageUuidAssigned, onMessageFailed, initialEffort, initialSpeed, initialModel, registerSnapshot, suspended = false }: MessageInputProps) {
  useRenderTracker('MessageInput')
  const { canUseAgent, isAuthMode } = useUser()
  const isViewOnly = !canUseAgent(agentSlug)
  const lastTypingNotification = useRef(0)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashMenuIndex, setSlashMenuIndex] = useState(0)
  const { data: agentPrefs, isFetched: agentPrefsFetched } = useAgentPreferences(agentSlug)
  const composerOptions = useComposerOptions({
    initialEffort,
    initialSpeed,
    initialModel,
    agentDefaultModel: agentPrefs?.defaultModel,
    agentDefaultEffort: agentPrefs?.defaultEffort,
    agentDefaultSpeed: agentPrefs?.defaultSpeed,
    agentKey: agentSlug,
    agentDefaultsReady: agentPrefsFetched,
  })
  const textareaRef = useRef<HTMLDivElement>(null)
  // Let out-of-tree components (file-preview comment bar) focus this composer.
  useEffect(() => registerSessionComposerFocus(sessionId, () => textareaRef.current?.focus()), [sessionId])
  const sendMessage = useSendMessage()
  const uploadFile = useUploadFile()
  const uploadFolder = useUploadFolder()
  const interruptSession = useInterruptSession()
  const { isActive, slashCommands, isWaitingBackground, backgroundTasks } = useMessageStream(sessionId, agentSlug)
  // The Stop dialog names what is running; the launching tool calls in the
  // transcript carry the names.
  const { data: messages } = useMessages(sessionId, agentSlug)
  const [stopDialogOpen, setStopDialogOpen] = useState(false)
  const stopDialogTasks = useMemo(
    () => (stopDialogOpen ? labelBackgroundTasks(backgroundTasks, messages) : []),
    [stopDialogOpen, backgroundTasks, messages]
  )
  // The tasks can finish while the question is open; with none left there is
  // nothing to decide, and the next Stop goes straight through.
  useEffect(() => {
    if (stopDialogOpen && backgroundTasks.length === 0) setStopDialogOpen(false)
  }, [stopDialogOpen, backgroundTasks.length])
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
      ({ file, onProgress, signal, stallMs }) => uploadFile.mutateAsync({ sessionId, agentSlug, file, onProgress, signal, stallMs }),
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
      const runtimeOptions = queued ? {} : composerOptions.toRuntimeOptions()
      onMessageSent?.(content, localId, queued)
      try {
        const result = await sendMessage.mutateAsync({
          sessionId,
          agentSlug,
          content,
          ...runtimeOptions,
        })
        // Only a fresh turn accepts runtime-option changes. The server's
        // queued decision is authoritative and may differ from our SSE-based
        // guess, so keep a user pick dirty when the server stripped it.
        if (!result.queued) composerOptions.markSubmitted(runtimeOptions)
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
      track('message_sent', { origin: 'user' })
    }, [onMessageSent, onMessageUuidAssigned, onMessageFailed, sendMessage, sessionId, agentSlug, track, composerOptions, isActive, isWaitingBackground]),
    submitDisabled: sendMessage.isPending || isOffline || !isRuntimeReady,
    draftKey: `session:${sessionId}`,
  })

  const snapshotRef = useRef<ComposerSnapshot>({
    text: '',
    attachments: [],
    model: undefined,
    effort: composerOptions.effort,
    speed: composerOptions.speed,
    securedSecrets: [],
  })
  snapshotRef.current = {
    text: composer.message,
    attachments: composer.attachments,
    model: composerOptions.model,
    effort: composerOptions.effort,
    speed: composerOptions.speed,
    securedSecrets: composer.securedSecrets,
  }
  useEffect(() => {
    if (!registerSnapshot) return
    registerSnapshot(() => snapshotRef.current)
    return () => registerSnapshot(null)
  }, [registerSnapshot])

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

  const handleChange = useCallback((value: string) => {
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

  const runInterrupt = async (scope: 'turn' | 'all') => {
    if (interruptSession.isPending) return
    try {
      await interruptSession.mutateAsync({ sessionId, agentSlug, scope })
    } catch (error) {
      console.error('Failed to interrupt session:', error)
    }
  }

  // Stop ends the response. Background tasks are the user's call: with any
  // running, ask whether they go too, instead of killing them silently.
  const handleInterrupt = () => {
    if (interruptSession.isPending) return
    if (backgroundTasks.length > 0) {
      setStopDialogOpen(true)
      return
    }
    void runInterrupt('turn')
  }

  const handleKeyDown = (e: KeyboardEvent) => {
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
      if (!composer.canSubmit) return
      void composer.handleSubmit(e)
    }
  }

  const isDisabled = sendMessage.isPending || composer.isUploading || isOffline || !isRuntimeReady

  // Voice mode. A session opened from the home page's voice button arrives
  // with the request already made (and the entry notice already sent as its
  // first message); otherwise it starts here, with the notice appended for
  // the agent to read with the next utterance.
  const [openedByVoice] = useState(() => isVoiceModeRequested(sessionId))
  const [voiceModeOn, setVoiceModeOn] = useState(openedByVoice)
  useEffect(() => clearVoiceModeRequest(sessionId), [sessionId])
  // The rest of the session view draws around the mic (activity card, hints).
  useEffect(() => {
    setVoiceModeActive(sessionId, voiceModeOn)
    return () => setVoiceModeActive(sessionId, false)
  }, [sessionId, voiceModeOn])
  // Its own mutation: the composer treats a pending send as "busy", and an
  // utterance spoken while the entry notice is still in flight must not be
  // dropped for it.
  // A notice that fails (the session was deleted, the app is offline as
  // the person leaves) is not worth a toast: the agent misses a hint.
  const sendNotice = useSendMessage({ quiet: true })
  const sendNoticeRef = useRef<(content: string) => void>(() => {})
  sendNoticeRef.current = (content: string) => {
    sendNotice.mutate(
      { sessionId, agentSlug, content, shouldQuery: false },
      { onError: (err) => console.warn('Voice-mode notice not delivered:', err) },
    )
  }
  const enterVoiceMode = useCallback(() => {
    // Audio output is unlocked inside the click, for the first reply to use.
    readAloud.unlockAudio()
    setVoiceModeOn(true)
    sendNoticeRef.current(VOICE_MODE_ENTERED_MESSAGE)
    track('voice_mode_entered', { origin: 'session' })
  }, [track])
  const exitVoiceMode = useCallback(() => setVoiceModeOn(false), [])
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Leaving voice mode — by the exit button or by navigating away from the
  // session — tells the agent. Deferred a tick so a development-mode
  // remount does not send it for a mode that is still on.
  useEffect(() => {
    if (!voiceModeOn) return
    return () => {
      const timer = setTimeout(() => sendNoticeRef.current(VOICE_MODE_EXITED_MESSAGE), 0)
      exitTimerRef.current = timer
    }
  }, [voiceModeOn])
  useEffect(() => {
    if (!voiceModeOn || exitTimerRef.current === null) return
    clearTimeout(exitTimerRef.current)
    exitTimerRef.current = null
  }, [voiceModeOn])
  const { submitMessage } = composer
  const voice = useVoiceMode({
    sessionId,
    agentSlug,
    active: voiceModeOn && !isViewOnly,
    paused: suspended,
    send: submitMessage,
    startWithAgentTurn: openedByVoice,
  })
  // Something to hear while the agent works, unless the person muted it.
  const holdSoundWanted = useHoldSoundPreference()
  useHoldSound({
    enabled: voiceModeOn && !isViewOnly && !suspended && holdSoundWanted,
    agentTurn: voice.phase !== 'listening',
    working: voice.working,
  })


  if (isViewOnly) {
    return null
  }

  if (voiceModeOn) {
    return (
      <div
        className={`relative z-10 isolate px-4 pt-0 ${composer.isDragOver ? 'ring-2 ring-primary ring-inset' : ''}`}
        {...composer.dragHandlers}
      >
        <MountChoiceDialog
          open={composer.mountDialog.open}
          onChoice={composer.mountDialog.onChoice}
          folderName={composer.mountDialog.folderName}
        />
        <VoiceModeComposer
          phase={voice.phase}
          utterance={voice.utterance}
          error={voice.error}
          onClearError={voice.clearError}
          onPressMic={voice.pressMic}
          getAnalyser={voice.getAnalyser}
          onExit={exitVoiceMode}
          attachments={composer.attachments}
          onRemoveAttachment={composer.removeAttachment}
          onRetryAttachment={composer.retryAttachment}
          attachmentPicker={(
            <AttachmentPicker
              onFileSelect={composer.handleFileSelect}
              onFolderSelect={composer.handleFolderSelect}
              onRecentFileAttach={(file) => composer.addFiles([{ file }])}
              disabled={isDisabled}
            />
          )}
          composerOptions={(
            <ComposerOptions
              state={composerOptions}
              disabled={isDisabled || isActive}
              footer={<AgentDefaultFooter agentSlug={agentSlug} state={composerOptions} />}
            />
          )}
          voiceControls={<VoiceModeControls />}
          footer={(
            <>
              {isOffline && (
                <div className="mt-2 flex items-center justify-center gap-1.5 text-xs text-destructive">
                  <WifiOff className="h-3 w-3 shrink-0" />
                  <span>No internet connection. Messages cannot be sent.</span>
                </div>
              )}
              <UploadError error={composer.uploadError} onDismiss={composer.clearUploadError} className="mt-2 justify-center" />
            </>
          )}
        />
      </div>
    )
  }

  return (
    <form
      onSubmit={composer.handleSubmit}
      className={`relative z-10 isolate px-4 pt-0 ${composer.isDragOver ? 'ring-2 ring-primary ring-inset' : ''}`}
      {...composer.dragHandlers}
    >
      <StopSessionDialog
        open={stopDialogOpen}
        onOpenChange={setStopDialogOpen}
        tasks={stopDialogTasks}
        // Waiting on background work means the response already ended; the
        // only thing left to stop is the tasks themselves.
        turnInProgress={!isWaitingBackground}
        onStopTurn={() => { setStopDialogOpen(false); void runInterrupt('turn') }}
        onStopAll={() => { setStopDialogOpen(false); void runInterrupt('all') }}
      />
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
        className={FLOATING_COMPOSER_CLASS}
        attachments={composer.attachments}
        onRemoveAttachment={composer.removeAttachment}
        onRetryAttachment={composer.retryAttachment}
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
        secureSecrets={{
          agentSlug,
          potentialSecrets: composer.potentialSecrets,
          securedSecrets: composer.securedSecrets,
          onDismiss: composer.dismissPotentialSecret,
          onSecure: composer.securePotentialSecret,
          onRemove: composer.removeSecuredSecrets,
        }}
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
            <ComposerOptions
              state={composerOptions}
              disabled={isDisabled || isActive}
              footer={<AgentDefaultFooter agentSlug={agentSlug} state={composerOptions} />}
            />
          </>
        )}
        rightActions={(
          <>
            <VoiceInputButton
              voiceInput={composer.voiceInput}
              message={composer.message}
              disabled={isDisabled}
            />
            {/* Not mid-dictation: that mic and socket would stay open under voice mode's own. */}
            <VoiceModeButton onClick={enterVoiceMode} disabled={isDisabled || composer.voiceInput.isRecording || composer.voiceInput.isConnecting} />
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
