import { useState, useCallback, useEffect, useRef } from 'react'
import { Button } from '@renderer/components/ui/button'
import { ChatComposerBox } from '@renderer/components/messages/chat-composer-box'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { useCreateAgent } from '@renderer/hooks/use-agents'
import { useCreateSession } from '@renderer/hooks/use-sessions'
import { useSelection } from '@renderer/context/selection-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import { apiFetch } from '@renderer/lib/api'
import { Loader2, Phone } from 'lucide-react'

const PLACEHOLDER_EXAMPLES = [
  // HR recruiter — one-shot
  'Search LinkedIn for senior backend engineers in NYC with 5+ years of Python experience. Reach out to the top 10 candidates with personalized intro messages.',
  // CEO — recurring weekly
  'Every Monday morning, pull highlights from my Granola meetings, Linear issues, and Slack DMs. Send me a briefing of key decisions and blockers from last week.',
  // Financial ops — recurring monthly
  'At the end of every month, reconcile expenses from my Gmail receipts against our QuickBooks ledger. Flag anything missing, duplicated, or out of policy.',
  // Product manager — recurring daily
  'Every morning, scan new Linear issues and customer feedback from our support inbox. Cluster them into themes and post a daily summary in our #product Slack channel.',
]

interface CreateAgentStepProps {
  onAgentCreated?: () => Promise<void> | void
}

export function CreateAgentStep({ onAgentCreated }: CreateAgentStepProps) {
  const [pendingAgentSlug, setPendingAgentSlug] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Typewriter placeholder cycle
  const [displayedPlaceholder, setDisplayedPlaceholder] = useState('')
  useEffect(() => {
    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout>

    const TYPE_MS = 25
    const DELETE_MS = 12
    const HOLD_FULL_MS = 2000
    const HOLD_EMPTY_MS = 350

    const run = (exampleIdx: number, charIdx: number, deleting: boolean) => {
      if (cancelled) return
      const fullText = PLACEHOLDER_EXAMPLES[exampleIdx]

      if (!deleting && charIdx <= fullText.length) {
        setDisplayedPlaceholder(fullText.slice(0, charIdx))
        if (charIdx === fullText.length) {
          timeoutId = setTimeout(() => run(exampleIdx, charIdx, true), HOLD_FULL_MS)
        } else {
          timeoutId = setTimeout(() => run(exampleIdx, charIdx + 1, false), TYPE_MS)
        }
      } else if (deleting && charIdx >= 0) {
        setDisplayedPlaceholder(fullText.slice(0, charIdx))
        if (charIdx === 0) {
          timeoutId = setTimeout(
            () => run((exampleIdx + 1) % PLACEHOLDER_EXAMPLES.length, 0, false),
            HOLD_EMPTY_MS
          )
        } else {
          timeoutId = setTimeout(() => run(exampleIdx, charIdx - 1, true), DELETE_MS)
        }
      }
    }

    run(0, 0, false)

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [])
  const createAgent = useCreateAgent()
  const createSession = useCreateSession()
  const { selectAgent, selectSession } = useSelection()
  const { track } = useAnalyticsTracking()

  const composer = useMessageComposer({
    agentSlug: pendingAgentSlug ?? '',
    uploadFile: useCallback(async ({ file }: { file: File }) => {
      if (!pendingAgentSlug) throw new Error('No agent yet')
      const formData = new FormData()
      formData.append('file', file)
      const res = await apiFetch(
        `/api/agents/${pendingAgentSlug}/upload-file`,
        { method: 'POST', body: formData }
      )
      if (!res.ok) throw new Error('Failed to upload file')
      return res.json() as Promise<{ path: string }>
    }, [pendingAgentSlug]),
    uploadFolder: useCallback(async ({ sourcePath }: { sourcePath: string }) => {
      if (!pendingAgentSlug) throw new Error('No agent yet')
      const res = await apiFetch(
        `/api/agents/${pendingAgentSlug}/upload-folder`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourcePath }),
        }
      )
      if (!res.ok) throw new Error('Failed to upload folder')
      return res.json() as Promise<{ path: string }>
    }, [pendingAgentSlug]),
    onSubmit: useCallback(async (content: string) => {
      try {
        // Ask the backend to generate a descriptive name from the prompt using the summarizer model
        let generatedName = ''
        try {
          const res = await apiFetch('/api/agents/generate-name', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: content.trim() }),
          })
          if (res.ok) {
            const data = await res.json() as { name?: string }
            generatedName = data.name?.trim() ?? ''
          }
        } catch {
          // Fall back to simple truncation if the generate endpoint fails
        }
        const fallbackName = content.trim().split(/\s+/).slice(0, 5).join(' ').slice(0, 50)
        const agentName = generatedName || fallbackName || 'My First Agent'
        const newAgent = await createAgent.mutateAsync({ name: agentName })
        track('agent_created', { source: 'new', num_skills_added_at_creation: 0 })
        setPendingAgentSlug(newAgent.slug)
        selectAgent(newAgent.slug)

        const session = await createSession.mutateAsync({
          agentSlug: newAgent.slug,
          message: content,
        })
        selectSession(session.id)

        await onAgentCreated?.()
      } catch (error) {
        console.error('Failed to create agent:', error)
      }
    }, [createAgent, createSession, selectAgent, selectSession, track, onAgentCreated]),
  })

  // Auto-resize textarea based on content, capped at 240px
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`
    }
  }, [composer.message])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void composer.handleSubmit(e as unknown as React.FormEvent)
    }
  }

  const isDisabled = createAgent.isPending || createSession.isPending

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Create Your First Agent</h2>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void composer.handleSubmit(e as unknown as React.FormEvent)
        }}
      >
        <ChatComposerBox
          textareaRef={textareaRef}
          attachments={composer.attachments}
          onRemoveAttachment={composer.removeAttachment}
          value={composer.message}
          onChange={(e) => composer.setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={composer.handlePaste}
          placeholder={displayedPlaceholder}
          disabled={isDisabled}
          rows={3}
          autoFocus
          dataTestId="wizard-agent-prompt"
          leftActions={(
            <AttachmentPicker
              onFileSelect={composer.handleFileSelect}
              onFolderSelect={composer.handleFolderSelect}
              disabled={isDisabled}
            />
          )}
          rightActions={(
            <>
              <VoiceInputButton voiceInput={composer.voiceInput} message={composer.message} disabled={isDisabled} />
              <Button
                type="submit"
                size="sm"
                data-testid="wizard-create-agent"
              >
                {isDisabled ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create Agent'
                )}
              </Button>
            </>
          )}
          footer={(
            <VoiceInputError error={composer.voiceInput.error} onDismiss={composer.voiceInput.clearError} className="mt-2 justify-center" />
          )}
        />
      </form>

      <div className="flex items-center gap-3 px-5 !mt-10">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-muted-foreground uppercase tracking-wider">or</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      <div className="flex items-center gap-4 pt-5">
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm">Need an idea? Try talking to Superagent.</p>
          <p className="text-sm text-muted-foreground mt-2">
            Take 5 min to answer a few questions about your<br />job and get a detailed prompt for your first agent.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" className="shrink-0 h-10 px-4">
          <Phone className="h-3 w-3" />
          Start conversation
        </Button>
      </div>
    </div>
  )
}
