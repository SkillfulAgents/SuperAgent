import { useCallback, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AudioLines, ArrowDownToLine, Shapes } from 'lucide-react'
import { OptionCard } from '@renderer/components/ui/option-card'
import { useDiscoverableAgents } from '@renderer/hooks/use-agent-templates'
import { ImportAgentDialog } from '@renderer/components/agents/import-agent-dialog'
import { useCanUseVoiceMode } from '@renderer/hooks/use-voice-input'
import { captureRendererException } from '@renderer/lib/error-reporting'
import type { ApiAgentTemplateInstallResult } from '@shared/lib/types/api'

export type ImportResult = ApiAgentTemplateInstallResult

export interface AgentCreationAidsProps {
  /** Starts a voice-mode session; the card shows only when voice mode is usable. */
  onStartVoiceMode: () => void
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
 * Browse / voice / import cards on an agent's empty home state. Callers decide
 * how a voice session starts and what to do with an imported agent — this
 * component is pure UI + dialog plumbing.
 */
export function AgentCreationAids({
  onStartVoiceMode,
  onImportComplete,
  className,
  onAidOpened,
  onNavigateAway,
}: AgentCreationAidsProps) {
  const navigate = useNavigate()
  const canUseVoiceMode = useCanUseVoiceMode()
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

        {canUseVoiceMode && (
          <OptionCard
            title="Brainstorm with Voice"
            icon={<AudioLines className="h-4 w-4" />}
            ariaDescription="Starts a voice mode session"
            onClick={() => {
              onAidOpened?.()
              onStartVoiceMode()
            }}
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

      <ImportAgentDialog
        open={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        onComplete={onImportComplete}
      />

    </div>
  )
}
