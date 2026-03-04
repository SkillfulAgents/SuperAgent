
import { Button } from '@renderer/components/ui/button'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useSendMessage, useUploadFile, useInterruptSession } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { Send, Loader2, StopCircle, Paperclip, WifiOff, Mic, MicOff } from 'lucide-react'
import { useIsOnline } from '@renderer/context/connectivity-context'
import { useUser } from '@renderer/context/user-context'
import { useDialogs } from '@renderer/context/dialog-context'
import { useSettings } from '@renderer/hooks/use-settings'
import { useVoiceInput } from '@renderer/hooks/use-voice-input'
import { AttachmentPreview, type Attachment } from './attachment-preview'
import { SlashCommandMenu } from './slash-command-menu'

interface MessageInputProps {
  sessionId: string
  agentSlug: string
  onMessageSent?: (content: string) => void
}

export function MessageInput({ sessionId, agentSlug, onMessageSent }: MessageInputProps) {
  const { canUseAgent } = useUser()
  const isViewOnly = !canUseAgent(agentSlug)
  const [message, setMessage] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashMenuIndex, setSlashMenuIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sendMessage = useSendMessage()
  const uploadFile = useUploadFile()
  const interruptSession = useInterruptSession()
  const { isActive, slashCommands } = useMessageStream(sessionId, agentSlug)
  const isOnline = useIsOnline()
  const isOffline = !isOnline
  const { data: settingsData } = useSettings()
  const { openSettings } = useDialogs()

  const hasVoiceConfigured = settingsData?.voice?.sttProvider && (
    (settingsData.voice.sttProvider === 'deepgram' && settingsData.apiKeyStatus?.deepgram?.isConfigured) ||
    (settingsData.voice.sttProvider === 'openai' && settingsData.apiKeyStatus?.openai?.isConfigured)
  )

  const voiceInput = useVoiceInput({
    onTranscriptUpdate: useCallback((text: string) => {
      setMessage(text)
    }, []),
  })

  const handleVoiceToggle = useCallback(() => {
    if (!hasVoiceConfigured) {
      openSettings('voice')
      return
    }
    if (voiceInput.isRecording || voiceInput.isConnecting) {
      voiceInput.stopRecording()
    } else {
      voiceInput.startRecording(message)
    }
  }, [hasVoiceConfigured, openSettings, voiceInput, message])

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

  const addFiles = useCallback((files: FileList | File[]) => {
    const newAttachments: Attachment[] = Array.from(files).map((file) => {
      const attachment: Attachment = {
        file,
        id: crypto.randomUUID(),
      }
      if (file.type.startsWith('image/')) {
        attachment.preview = URL.createObjectURL(file)
      }
      return attachment
    })
    setAttachments((prev) => [...prev, ...newAttachments])
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id)
      if (removed?.preview) {
        URL.revokeObjectURL(removed.preview)
      }
      return prev.filter((a) => a.id !== id)
    })
  }, [])

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      attachments.forEach((a) => {
        if (a.preview) URL.revokeObjectURL(a.preview)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const hasContent = message.trim() || attachments.length > 0
    if (!hasContent || sendMessage.isPending || isActive || isUploading) return

    let content = message.trim()

    // Upload attachments first
    if (attachments.length > 0) {
      setIsUploading(true)
      try {
        const uploadResults = await Promise.all(
          attachments.map((a) =>
            uploadFile.mutateAsync({ sessionId, agentSlug, file: a.file })
          )
        )

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

    // Stop voice recording if active
    if (voiceInput.isRecording || voiceInput.isConnecting) {
      voiceInput.stopRecording()
    }

    // Clear state before sending
    onMessageSent?.(content)
    setMessage('')
    // Cleanup previews
    attachments.forEach((a) => {
      if (a.preview) URL.revokeObjectURL(a.preview)
    })
    setAttachments([])

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

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files)
      // Reset input so same file can be selected again
      e.target.value = ''
    }
  }

  const isDisabled = sendMessage.isPending || isActive || isUploading || isOffline

  if (isViewOnly) {
    return null
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={`relative px-4 py-[18px] border-t bg-background ${isDragOver ? 'ring-2 ring-primary ring-inset' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <SlashCommandMenu
        commands={filteredCommands}
        selectedIndex={slashMenuIndex}
        onSelect={selectSlashCommand}
        visible={slashMenuOpen}
        filter={slashFilter ?? ''}
      />
      <AttachmentPreview attachments={attachments} onRemove={removeAttachment} />
      <div className={`flex items-center gap-2 ${attachments.length > 0 ? 'mt-2' : ''}`}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-[34px] w-[34px]"
          onClick={() => fileInputRef.current?.click()}
          disabled={isDisabled}
          title="Attach file"
        >
          <Paperclip className="h-4 w-4" />
        </Button>
        {voiceInput.isSupported && (
          <Button
            type="button"
            size="icon"
            variant={voiceInput.isRecording ? 'destructive' : 'ghost'}
            className={`h-[34px] w-[34px] ${voiceInput.isRecording ? 'animate-pulse' : ''}`}
            onClick={handleVoiceToggle}
            disabled={isDisabled && !voiceInput.isRecording}
            title={
              !hasVoiceConfigured
                ? 'Set up voice input'
                : voiceInput.isRecording
                  ? 'Stop recording'
                  : 'Voice input'
            }
          >
            {voiceInput.isConnecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : voiceInput.isRecording ? (
              <MicOff className="h-4 w-4" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </Button>
        )}
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
            disabled={(!message.trim() && attachments.length === 0) || sendMessage.isPending || isUploading}
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
    </form>
  )
}
