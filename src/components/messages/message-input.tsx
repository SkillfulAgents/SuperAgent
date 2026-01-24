'use client'

import { Button } from '@/components/ui/button'
import { useState, useRef, useEffect } from 'react'
import { useSendMessage, useInterruptSession } from '@/lib/hooks/use-messages'
import { useMessageStream } from '@/lib/hooks/use-message-stream'
import { Send, Loader2, StopCircle } from 'lucide-react'

interface MessageInputProps {
  sessionId: string
  agentSlug: string
  onMessageSent?: (content: string) => void
}

export function MessageInput({ sessionId, agentSlug, onMessageSent }: MessageInputProps) {
  const [message, setMessage] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sendMessage = useSendMessage()
  const interruptSession = useInterruptSession()
  const { isStreaming, isActive } = useMessageStream(sessionId)

  const handleInterrupt = async () => {
    if (interruptSession.isPending) return
    try {
      await interruptSession.mutateAsync(sessionId)
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
    if (!message.trim() || sendMessage.isPending || isActive) return

    const content = message.trim()
    // Immediately notify parent so message appears in UI
    onMessageSent?.(content)
    setMessage('')

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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  const isDisabled = sendMessage.isPending || isActive

  return (
    <form onSubmit={handleSubmit} className="p-4 border-t bg-background">
      <div className="flex gap-2">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isActive ? 'Agent is responding...' : 'Type a message...'}
          disabled={isDisabled}
          className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 min-h-[40px] max-h-[200px] overflow-y-auto"
          rows={1}
        />
        {isActive ? (
          <Button
            type="button"
            size="icon"
            variant="destructive"
            onClick={handleInterrupt}
            disabled={interruptSession.isPending}
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
            disabled={!message.trim() || sendMessage.isPending}
          >
            {sendMessage.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        )}
      </div>
    </form>
  )
}
