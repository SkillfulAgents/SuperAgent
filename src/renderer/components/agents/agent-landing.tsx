
import { useState, useRef, useCallback, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { Send, Loader2, Sparkles, Paperclip } from 'lucide-react'
import { useCreateSession } from '@renderer/hooks/use-sessions'
import { useAgentSkills } from '@renderer/hooks/use-agent-skills'
import { apiFetch } from '@renderer/lib/api'
import { AttachmentPreview, type Attachment } from '@renderer/components/messages/attachment-preview'
import type { ApiAgent } from '@renderer/hooks/use-agents'

interface AgentLandingProps {
  agent: ApiAgent
  onSessionCreated: (sessionId: string, initialMessage: string) => void
}

export function AgentLanding({ agent, onSessionCreated }: AgentLandingProps) {
  const [message, setMessage] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const createSession = useCreateSession()
  const { data: skills } = useAgentSkills(agent.slug)

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
    if (!hasContent || createSession.isPending || isUploading) return

    try {
      let content = message.trim()

      // Upload attachments first (using agent-level endpoint, no session needed)
      if (attachments.length > 0) {
        setIsUploading(true)
        try {
          const uploadResults = await Promise.all(
            attachments.map(async (a) => {
              const formData = new FormData()
              formData.append('file', a.file)
              const res = await apiFetch(
                `/api/agents/${agent.slug}/upload-file`,
                { method: 'POST', body: formData }
              )
              if (!res.ok) throw new Error('Failed to upload file')
              return res.json() as Promise<{ path: string; filename: string; size: number }>
            })
          )

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

      // Create session with the message (including file paths)
      const session = await createSession.mutateAsync({
        agentSlug: agent.slug,
        message: content,
      })

      setMessage('')
      attachments.forEach((a) => {
        if (a.preview) URL.revokeObjectURL(a.preview)
      })
      setAttachments([])
      onSessionCreated(session.id, content)
    } catch (error) {
      console.error('Failed to start session:', error)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
      e.target.value = ''
    }
  }

  const isDisabled = createSession.isPending || isUploading

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-2xl space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold">
            Start a conversation with {agent.name}
          </h1>
          <p className="text-muted-foreground">
            Send a message to begin a new session
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className={`space-y-4 ${isDragOver ? 'ring-2 ring-primary rounded-lg' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="relative">
            <Textarea
              placeholder="Type your message..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              className="min-h-[120px] pr-12 resize-none text-base"
              disabled={isDisabled}
              autoFocus
              data-testid="landing-message-input"
            />
            <div className="absolute bottom-3 right-3 flex gap-1">
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
                className="h-8 w-8"
                onClick={() => fileInputRef.current?.click()}
                disabled={isDisabled}
                title="Attach file"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              <Button
                type="submit"
                size="icon"
                className="h-8 w-8"
                disabled={(!message.trim() && attachments.length === 0) || isDisabled}
                data-testid="landing-send-button"
              >
                {isDisabled ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
          <AttachmentPreview attachments={attachments} onRemove={removeAttachment} />
          <p className="text-xs text-muted-foreground text-center">
            Press Enter to send, Shift+Enter for new line
          </p>
        </form>

        {/* Skills Section */}
        {skills && skills.length > 0 && (
          <div className="pt-6 border-t">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium text-muted-foreground">
                Available Skills
              </h2>
            </div>
            <div className="grid gap-2">
              {skills.map((skill) => (
                <div
                  key={skill.path}
                  className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{skill.name}</p>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {skill.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
