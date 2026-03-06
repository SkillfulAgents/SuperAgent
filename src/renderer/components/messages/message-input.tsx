
import { Button } from '@renderer/components/ui/button'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useSendMessage, useUploadFile, useInterruptSession } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { Send, Loader2, StopCircle, WifiOff } from 'lucide-react'
import { useIsOnline } from '@renderer/context/connectivity-context'
import { useUser } from '@renderer/context/user-context'
import { useVoiceInput } from '@renderer/hooks/use-voice-input'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { AttachmentPreview } from './attachment-preview'
import { SlashCommandMenu } from './slash-command-menu'
import { useAttachments } from '@renderer/hooks/use-attachments'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'

interface MessageInputProps {
  sessionId: string
  agentSlug: string
  onMessageSent?: (content: string) => void
}

export function MessageInput({ sessionId, agentSlug, onMessageSent }: MessageInputProps) {
  const { canUseAgent } = useUser()
  const isViewOnly = !canUseAgent(agentSlug)
  const [message, setMessage] = useState('')
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashMenuIndex, setSlashMenuIndex] = useState(0)
  const [isUploading, setIsUploading] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sendMessage = useSendMessage()
  const uploadFile = useUploadFile()
  const interruptSession = useInterruptSession()
  const { isActive, slashCommands } = useMessageStream(sessionId, agentSlug)
  const isOnline = useIsOnline()
  const isOffline = !isOnline

  const {
    attachments,
    isDragOver,
    removeAttachment,
    clearAttachments,
    handleFileSelect,
    handleFolderSelect,
    dragHandlers,
  } = useAttachments()

  const voiceInput = useVoiceInput({
    onTranscriptUpdate: useCallback((text: string) => {
      setMessage(text)
    }, []),
  })

  // Extract the slash command prefix being typed (e.g. "co" from "/co")
  const slashFilter = useMemo(() => {
    const match = message.match(/^\/(\S*)$/)
    return match ? match[1] : null
  }, [message])

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
    setMessage(`/${name} `)
    setSlashMenuOpen(false)
    textareaRef.current?.focus()
  }, [])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setMessage(value)

    // Open slash menu when input is "/" followed by optional non-space chars (still typing command)
    if (/^\/\S*$/.test(value) && slashCommands.length > 0) {
      setSlashMenuOpen(true)
      setSlashMenuIndex(0)
    } else {
      setSlashMenuOpen(false)
    }
  }, [slashCommands.length])

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
  }, [message])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Stop voice recording first — use returned text since React state won't update synchronously
    let voiceText: string | undefined
    if (voiceInput.isRecording || voiceInput.isConnecting) {
      voiceText = voiceInput.stopRecording()
    }

    const effectiveMessage = voiceText ?? message
    const hasContent = effectiveMessage.trim() || attachments.length > 0
    if (!hasContent || sendMessage.isPending || isActive || isUploading) return

    let content = effectiveMessage.trim()

    // Upload attachments first
    if (attachments.length > 0) {
      setIsUploading(true)
      try {
        const uploadPromises = attachments.flatMap((a) => {
          if (a.type === 'folder') {
            return a.files.map((f) =>
              uploadFile.mutateAsync({ sessionId, agentSlug, file: f.file, relativePath: f.relativePath })
            )
          }
          return [uploadFile.mutateAsync({ sessionId, agentSlug, file: a.file })]
        })
        const uploadResults = await Promise.all(uploadPromises)

        // Append file paths to message
        const filePaths = uploadResults.map((r) => `- ${r.path}`).join('\n')
        if (content) {
          content = `${content}\n\n[Attached files:]\n${filePaths}`
        } else {
          content = `[Attached files:]\n${filePaths}`
        }
      } catch (error) {
        console.error('Failed to upload attachments:', error)
        setIsUploading(false)
        return
      }
      setIsUploading(false)
    }

    // Clear state before sending
    onMessageSent?.(content)
    setMessage('')
    clearAttachments()

    try {
      await sendMessage.mutateAsync({
        sessionId,
        agentSlug,
        content,
      })
    } catch (error) {
      console.error('Failed to send message:', error)
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
      e.preventDefault()
      handleSubmit(e)
    }
  }

  const isDisabled = sendMessage.isPending || isActive || isUploading || isOffline

  if (isViewOnly) {
    return null
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={`relative pl-2 pr-4 py-[18px] border-t bg-background ${isDragOver ? 'ring-2 ring-primary ring-inset' : ''}`}
      {...dragHandlers}
    >
      <SlashCommandMenu
        commands={filteredCommands}
        selectedIndex={slashMenuIndex}
        onSelect={selectSlashCommand}
        visible={slashMenuOpen}
        filter={slashFilter ?? ''}
      />
      <AttachmentPreview attachments={attachments} onRemove={removeAttachment} />
      <div className={`flex items-center gap-1 ${attachments.length > 0 ? 'mt-2' : ''}`}>
        <AttachmentPicker
          onFileSelect={handleFileSelect}
          onFolderSelect={handleFolderSelect}
          disabled={isDisabled}
        />
        <VoiceInputButton voiceInput={voiceInput} message={message} disabled={isDisabled} />
        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (slashFilter !== null && slashCommands.length > 0) setSlashMenuOpen(true) }}
          onBlur={() => setSlashMenuOpen(false)}
          placeholder={
            isOffline
              ? 'No internet connection...'
              : isActive
                ? 'Agent is responding...'
                : 'Type a message...'
          }
          disabled={isDisabled}
          className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 min-h-9 max-h-[200px] overflow-y-auto"
          rows={1}
          data-testid="message-input"
        />
        {isActive ? (
          <Button
            type="button"
            size="icon"
            variant="destructive"
            className="h-[34px] w-[34px]"
            onClick={handleInterrupt}
            disabled={interruptSession.isPending}
            data-testid="stop-button"
          >
            {interruptSession.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <StopCircle className="h-4 w-4" />
            )}
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            className="h-[34px] w-[34px]"
            disabled={(!message.trim() && attachments.length === 0 && !voiceInput.isRecording) || sendMessage.isPending || isUploading}
            data-testid="send-button"
          >
            {sendMessage.isPending || isUploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        )}
      </div>
      {isOffline && !isActive && (
        <div className="flex items-center gap-1.5 mt-2 text-xs text-destructive">
          <WifiOff className="h-3 w-3 shrink-0" />
          <span>No internet connection. Messages cannot be sent.</span>
        </div>
      )}
      <VoiceInputError error={voiceInput.error} onDismiss={voiceInput.clearError} className="mt-2" />
    </form>
  )
}
