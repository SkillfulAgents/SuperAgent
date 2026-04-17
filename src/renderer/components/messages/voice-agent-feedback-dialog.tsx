import { useState, useCallback, useEffect, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Loader2 } from 'lucide-react'
import { VoiceAgent } from '@renderer/components/ui/voice-agent'
import { apiFetch } from '@renderer/lib/api'
import type { VoiceAgentConfig } from '@renderer/lib/voice-agent'
import type { ApiMessage } from '@shared/lib/types/api'

interface VoiceAgentFeedbackDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentInstructions: string
  messages: ApiMessage[]
  /** Set the draft text in the message input */
  onSetDraft?: (draft: string) => void
}

export function VoiceAgentFeedbackDialog({
  open,
  onOpenChange,
  agentInstructions,
  messages,
  onSetDraft,
}: VoiceAgentFeedbackDialogProps) {
  const [voiceAgentConfig, setVoiceAgentConfig] = useState<VoiceAgentConfig | null>(null)
  const [isDrafting, setIsDrafting] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Capture messages and instructions at open time so streaming messages
  // don't cause the config to reload mid-conversation
  const messagesAtOpenRef = useRef(messages)
  const instructionsAtOpenRef = useRef(agentInstructions)

  // Load the prompt and build config when dialog opens
  useEffect(() => {
    if (!open) {
      setVoiceAgentConfig(null)
      return
    }

    // Snapshot the current values when the dialog opens
    messagesAtOpenRef.current = messages
    instructionsAtOpenRef.current = agentInstructions

    let cancelled = false
    async function loadConfig() {
      try {
        const res = await apiFetch('/api/stt/voice-agent-prompt?name=improve-agent')
        if (!res.ok) throw new Error('Failed to load voice agent prompt')
        if (cancelled) return
        const { prompt } = await res.json() as { prompt: string }
        if (cancelled) return

        const currentMessages = messagesAtOpenRef.current
        const currentInstructions = instructionsAtOpenRef.current

        // Build conversation transcript to embed in the system prompt
        // (Using agent.context.messages causes Deepgram API parsing errors,
        // so we inline the transcript directly into the prompt instead)
        const transcriptLines = currentMessages
          .filter((m) => m.content.text && m.content.text.trim().length > 0)
          .slice(-20) // Cap to last 20 messages
          .map((m) => `${m.type === 'user' ? 'User' : 'Assistant'}: ${m.content.text.trim()}`)

        const transcriptBlock = transcriptLines.length > 0
          ? `\n\n## Recent Conversation\n\nHere is the recent conversation between the user and their agent:\n\n${transcriptLines.join('\n\n')}`
          : ''

        // Augment the system prompt with conversation context and current instructions
        const augmentedPrompt = `${prompt}${transcriptBlock}\n\n## Current Agent Instructions\n\nThe agent's current system prompt is:\n\n---\n${currentInstructions || '(No instructions set)'}\n---`

        setVoiceAgentConfig({
          systemPrompt: augmentedPrompt,
          tools: [{
            name: 'submit_feedback',
            description: 'Submit the distilled feedback message to send to the agent',
            parameters: {
              type: 'object',
              properties: {
                feedback_message: {
                  type: 'string',
                  description: 'A clear, actionable message addressed to the agent summarizing what the user wants changed',
                },
              },
              required: ['feedback_message'],
            },
          }],
          greeting: 'I can see your recent conversation. What would you like to improve about this agent?',
        })
      } catch (error) {
        console.error('Failed to load voice agent config:', error)
      }
    }

    void loadConfig()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when open changes, not on every message
  }, [open])

  const handleResult = useCallback(async (_name: string, argsJson: string) => {
    try {
      const args = JSON.parse(argsJson) as { feedback_message: string }

      // Clear config so VoiceAgent won't remount when isDrafting clears
      setVoiceAgentConfig(null)
      setIsDrafting(true)
      await new Promise((r) => setTimeout(r, 3000))
      if (!mountedRef.current) return

      // Put the feedback message into the message input for the user to review and edit
      onSetDraft?.(args.feedback_message)
      setIsDrafting(false)
      onOpenChange(false)
    } catch (error) {
      console.error('Failed to process Voice Agent feedback:', error)
      setIsDrafting(false)
    }
  }, [onSetDraft, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Voice Feedback</DialogTitle>
          <DialogDescription>
            Talk about what you&apos;d like to improve. The agent will update its instructions based on your feedback.
          </DialogDescription>
        </DialogHeader>

        {isDrafting ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Drafting suggestion...</p>
          </div>
        ) : voiceAgentConfig ? (
          <VoiceAgent
            config={voiceAgentConfig}
            onResult={handleResult}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            Loading...
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
