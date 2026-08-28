import { useCallback, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AudioLines, ArrowDownToLine, Shapes } from 'lucide-react'
import { toast } from 'sonner'
import { OptionCard } from '@renderer/components/ui/option-card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { VoiceAgent } from '@renderer/components/ui/voice-agent'
import { apiFetch } from '@renderer/lib/api'
import { useDiscoverableAgents } from '@renderer/hooks/use-agent-templates'
import { ImportAgentDialog } from '@renderer/components/agents/import-agent-dialog'
import { useIsVoiceAgentConfigured } from '@renderer/hooks/use-voice-input'
import { captureRendererException } from '@renderer/lib/error-reporting'
import type { VoiceAgentConfig } from '@renderer/lib/voice-agent'
import type { ApiAgentTemplateInstallResult } from '@shared/lib/types/api'

export type ImportResult = ApiAgentTemplateInstallResult

export interface AgentCreationAidsProps {
  /** Called after the voice agent interview completes with its tool-call args. */
  onVoiceResult: (args: { name: string; prompt: string }) => void
  /** Called after a successful import (post-env-var prompt if any). */
  onImportComplete: (result: ImportResult) => void | Promise<void>
  /** Optional className forwarded to the cards wrapper. */
  className?: string
  /** Fires when the user opens browse / voice / import (forfeits signup template handoff). */
  onAidOpened?: () => void
  /**
   * Awaited before leaving for the marketplace. The wizard hosts this form in
   * a full-screen overlay that sits ABOVE the router, so it has to finish
   * itself first or the user navigates to a page they can't see.
   */
  onNavigateAway?: () => void | Promise<void>
}

/**
 * Voice-agent-for-ideas + Import cards that originally lived inside the
 * Create New Agent modal. Now used as creation aids on an agent's empty
 * home state. Callers decide what to do with the voice result / imported
 * agent — this component is pure UI + dialog plumbing.
 */
export function AgentCreationAids({
  onVoiceResult,
  onImportComplete,
  className,
  onAidOpened,
  onNavigateAway,
}: AgentCreationAidsProps) {
  const navigate = useNavigate()
  const hasVoiceConfigured = useIsVoiceAgentConfigured()
  const { data: discoverableAgents } = useDiscoverableAgents()
  const hasMarketplace = !!(discoverableAgents && discoverableAgents.length > 0)

  const browseTemplates = useCallback(async () => {
    onAidOpened?.()
    // The hook can reject — the wizard's is a settings PUT, and that mutation
    // carries `skipGlobalErrorToast`, so a failure is otherwise silent. Leave
    // for the marketplace either way: a click that does nothing at all is the
    // worse outcome, and the host staying open is its own visible signal.
    try {
      await onNavigateAway?.()
    } catch (error) {
      console.error('[create-agent] navigate-away hook failed:', error)
      captureRendererException(error, {
        tags: { area: 'create-agent', op: 'browse-templates' },
      })
    }
    void navigate({ to: '/explore' })
  }, [onAidOpened, onNavigateAway, navigate])

  // --- Voice agent flow ---
  const [showVoiceAgent, setShowVoiceAgent] = useState(false)
  const [voiceAgentConfig, setVoiceAgentConfig] = useState<VoiceAgentConfig | null>(null)

  const startVoiceAgent = useCallback(async () => {
    onAidOpened?.()
    try {
      const res = await apiFetch('/api/stt/voice-agent-prompt?name=create-agent')
      if (!res.ok) throw new Error('Failed to load voice agent prompt')
      const { prompt } = (await res.json()) as { prompt: string }
      setVoiceAgentConfig({
        systemPrompt: prompt,
        tools: [
          {
            name: 'submit_agent',
            description: 'Submit the agent name and system prompt after the interview is complete',
            parameters: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Short descriptive name for the agent (2-4 words)' },
                prompt: { type: 'string', description: 'Detailed system prompt for the agent' },
              },
              required: ['name', 'prompt'],
            },
          },
        ],
      })
      setShowVoiceAgent(true)
    } catch (error) {
      console.error('Failed to start Voice Agent:', error)
      toast.error('Could not start voice agent', {
        description: error instanceof Error ? error.message : 'Please try again.',
      })
    }
  }, [onAidOpened])

  const handleVoiceAgentResult = useCallback(
    (_name: string, argsJson: string) => {
      try {
        const args = JSON.parse(argsJson) as { name: string; prompt: string }
        setShowVoiceAgent(false)
        setVoiceAgentConfig(null)
        onVoiceResult(args)
      } catch (error) {
        console.error('Failed to process Voice Agent result:', error)
      }
    },
    [onVoiceResult],
  )

  const closeVoiceAgent = useCallback(() => {
    setShowVoiceAgent(false)
    setVoiceAgentConfig(null)
  }, [])

  // --- Import flow (dialog extracted to ImportAgentDialog) ---
  const [showImportDialog, setShowImportDialog] = useState(false)

  return (
    <div className={className}>
      <p className="mb-3 text-xs text-muted-foreground">Other ways to get started</p>
      <div className="flex flex-wrap gap-3">
        {hasMarketplace && (
          <OptionCard
            title="Browse Templates"
            icon={<Shapes className="h-4 w-4" />}
            ariaDescription="Opens the agent template marketplace"
            onClick={() => void browseTemplates()}
          />
        )}

        {hasVoiceConfigured && (
          <OptionCard
            title="Brainstorm with Voice"
            icon={<AudioLines className="h-4 w-4" />}
            ariaDescription="Start a voice interview to draft your agent prompt"
            onClick={startVoiceAgent}
          />
        )}

        <OptionCard
          title="Import an Agent"
          icon={<ArrowDownToLine className="h-4 w-4" />}
          ariaDescription="Import an agent from a .agent or .zip template file"
          onClick={() => {
            onAidOpened?.()
            setShowImportDialog(true)
          }}
        />
      </div>

      <Dialog open={showVoiceAgent} onOpenChange={(open) => { if (!open) closeVoiceAgent() }}>
        <DialogContent className="max-w-2xl p-0 overflow-hidden h-[420px] [grid-template-rows:minmax(0,1fr)] gap-0">
          <DialogHeader className="sr-only">
            <DialogTitle>Let&apos;s talk about your agent</DialogTitle>
            <DialogDescription>
              Answer a few quick questions and Gamut will draft a detailed prompt for you to review.
            </DialogDescription>
          </DialogHeader>
          {voiceAgentConfig && (
            <VoiceAgent
              config={voiceAgentConfig}
              onResult={handleVoiceAgentResult}
              onClose={closeVoiceAgent}
              layout="split"
            />
          )}
        </DialogContent>
      </Dialog>

      <ImportAgentDialog
        open={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        onComplete={onImportComplete}
      />

    </div>
  )
}
