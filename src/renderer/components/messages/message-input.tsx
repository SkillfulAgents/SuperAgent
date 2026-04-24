
import { Button } from '@renderer/components/ui/button'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { getApiBaseUrl } from '@renderer/lib/env'
import { useSendMessage, useUploadFile, useUploadFolder, useInterruptSession } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { ArrowUp, Loader2, Square, WifiOff } from 'lucide-react'
import { useIsOnline } from '@renderer/context/connectivity-context'
import { useUser } from '@renderer/context/user-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { SlashCommandMenu } from './slash-command-menu'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import { ChatComposerBox } from './chat-composer-box'
import { EffortSelector } from './effort-selector'
import { useRenderTracker } from '@renderer/lib/perf'
import type { EffortLevel } from '@shared/lib/container/types'
import { cn } from '@shared/lib/utils'

interface MessageInputProps {
  sessionId: string
  agentSlug: string
  onMessageSent?: (content: string) => void
  /** Effort level last used on this session; seeds the composer selector. Defaults to 'high' when absent. */
  initialEffort?: EffortLevel
}

export function MessageInput({ sessionId, agentSlug, onMessageSent, initialEffort }: MessageInputProps) {
  useRenderTracker('MessageInput')
  const { canUseAgent, isAuthMode } = useUser()
  const isViewOnly = !canUseAgent(agentSlug)
  const lastTypingNotification = useRef(0)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashMenuIndex, setSlashMenuIndex] = useState(0)
  const [effort, setEffort] = useState<EffortLevel>(initialEffort ?? 'high')
  // If session data loads after this component mounts, seed effort from it once.
  // After the first seed, user edits via setEffort take precedence.
  const effortSeededRef = useRef(initialEffort !== undefined)
  useEffect(() => {
    if (!effortSeededRef.current && initialEffort !== undefined) {
      setEffort(initialEffort)
      effortSeededRef.current = true
    }
  }, [initialEffort])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sendMessage = useSendMessage()
  const uploadFile = useUploadFile()
  const uploadFolder = useUploadFolder()
  const interruptSession = useInterruptSession()
  const { isActive, slashCommands } = useMessageStream(sessionId, agentSlug)
  const isOnline = useIsOnline()
  const isOffline = !isOnline
  const { track } = useAnalyticsTracking()

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
      onMessageSent?.(content)
      await sendMessage.mutateAsync({ sessionId, agentSlug, content, effort })
      track('message_sent')
    }, [onMessageSent, sendMessage, sessionId, agentSlug, track, effort]),
    submitDisabled: sendMessage.isPending || isActive || isOffline,
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

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }, [composer.message])

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
      e.preventDefault()
      composer.handleSubmit(e)
    }
  }

  const isDisabled = sendMessage.isPending || composer.isUploading || isOffline


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
        dataTestId="message-input"
        leftActions={(
          <>
            <AttachmentPicker
              onFileSelect={composer.handleFileSelect}
              onFolderSelect={composer.handleFolderSelect}
              onRecentFileAttach={(file) => composer.addFiles([{ file }])}
              disabled={isDisabled}
            />
            <EffortSelector
              value={effort}
              onChange={setEffort}
              disabled={isDisabled}
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
            <Button
              type={isActive ? 'button' : 'submit'}
              variant={isActive ? 'outline' : 'default'}
              size="icon"
              className="relative h-[34px] w-[34px] transition-colors"
              onClick={isActive ? handleInterrupt : undefined}
              disabled={isActive ? interruptSession.isPending : sendMessage.isPending}
              data-testid={isActive ? 'stop-button' : 'send-button'}
              aria-label={isActive ? 'Stop message' : 'Send message'}
            >
              <span
                className={cn(
                  'absolute inset-0 flex items-center justify-center transition-opacity duration-200',
                  isActive ? 'opacity-0' : 'opacity-100'
                )}
                aria-hidden={isActive}
              >
                {sendMessage.isPending || composer.isUploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
              </span>
              <span
                className={cn(
                  'absolute inset-0 flex items-center justify-center transition-opacity duration-200',
                  isActive ? 'opacity-100' : 'opacity-0'
                )}
                aria-hidden={!isActive}
              >
                {interruptSession.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Square className="h-3.5 w-3.5 fill-current" />
                )}
              </span>
            </Button>
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
          </>
        )}
      />
    </form>
  )
}
