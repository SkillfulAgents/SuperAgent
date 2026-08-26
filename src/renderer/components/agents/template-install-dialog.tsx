import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { useInstallAgentFromSkillset } from '@renderer/hooks/use-agent-templates'
import type { ApiAgentTemplateInstallResult, ApiDiscoverableAgent } from '@shared/lib/types/api'

type Phase = 'installing' | 'error'

interface TemplateInstallDialogProps {
  template: ApiDiscoverableAgent | null
  onClose: () => void
  /** Called after the agent is fully installed. */
  onInstalled: (agent: ApiAgentTemplateInstallResult) => void | Promise<void>
}

/**
 * Install progress for a marketplace template. There is nothing to fill in —
 * the agent takes the template's own name — so opening this dialog starts the
 * install immediately and hands off the moment it lands. The spinner shows
 * only for as long as the request actually takes; it is not paced.
 */
export function TemplateInstallDialog({ template, onClose, onInstalled }: TemplateInstallDialogProps) {
  const [phase, setPhase] = useState<Phase>('installing')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const install = useInstallAgentFromSkillset()

  // One install per opening. A re-render must not fire a second one, and the
  // ref (not state) is what makes that true even under StrictMode double-invoke.
  const startedFor = useRef<string | null>(null)

  const run = useCallback(
    async (target: ApiDiscoverableAgent) => {
      setPhase('installing')
      setErrorMessage(null)
      try {
        const agent = await install.mutateAsync({
          skillsetId: target.skillsetId,
          agentPath: target.path,
          agentName: target.name,
          agentVersion: target.version,
        })
        // Close before onInstalled — that path may open the onboarding
        // "Setting up your agent..." dialog; stacking both looks broken.
        onClose()
        await onInstalled(agent)
      } catch (error) {
        console.error('Failed to install agent from skillset:', error)
        setErrorMessage(error instanceof Error ? error.message : 'Something went wrong.')
        setPhase('error')
      }
    },
    [install, onClose, onInstalled],
  )

  useEffect(() => {
    if (!template) {
      startedFor.current = null
      return
    }
    const id = `${template.skillsetId}/${template.path}`
    if (startedFor.current === id) return
    startedFor.current = id
    void run(template)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the template; `run` changes identity every render
  }, [template])

  return (
    <Dialog
      open={!!template}
      onOpenChange={(open) => {
        // No dismissing mid-install: the request is already in flight, and a
        // half-installed agent behind a closed dialog is worse than waiting.
        if (!open && phase !== 'installing') onClose()
      }}
    >
      <DialogContent className="max-w-sm" hideClose={phase === 'installing'}>
        <DialogHeader>
          <DialogTitle>
            {phase === 'error' ? `Couldn't install ${template?.name}` : `Installing ${template?.name}`}
          </DialogTitle>
          <DialogDescription>
            {phase === 'error' ? errorMessage : `From ${template?.skillsetName}`}
          </DialogDescription>
        </DialogHeader>

        {phase === 'error' ? (
          <div className="flex justify-end pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : (
          <div
            className="flex items-center gap-2.5 pt-2 text-sm text-muted-foreground"
            data-testid="template-install-status"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Installing…
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
