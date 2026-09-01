import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogDescription,
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import {
  StatusDialogContent,
  StatusDialogHeader,
  StatusDialogTitle,
} from '@renderer/components/agents/status-dialog'
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
 * Paced install progress. The install request emits no progress events, so the
 * bar eases toward 90% and holds. When `active` goes false the last value is
 * kept, not reset — the dialog stays mounted through its close animation, and
 * a bar snapping back to 0% right at the success moment reads as a failure.
 */
function useSimulatedProgress(active: boolean) {
  const [percent, setPercent] = useState(0)
  useEffect(() => {
    if (!active) return
    setPercent(0)
    const startedAt = performance.now()
    const id = window.setInterval(() => {
      const seconds = (performance.now() - startedAt) / 1000
      setPercent(90 * (1 - Math.exp(-seconds / 4)))
    }, 150)
    return () => window.clearInterval(id)
  }, [active])
  return percent
}

/**
 * Install progress for a marketplace template. There is nothing to fill in —
 * the agent takes the template's own name — so opening this dialog starts the
 * install immediately and hands off the moment it lands. The progress bar is
 * simulated (see useSimulatedProgress); the dialog still closes as soon as the
 * request actually finishes.
 */
export function TemplateInstallDialog({ template, onClose, onInstalled }: TemplateInstallDialogProps) {
  const [phase, setPhase] = useState<Phase>('installing')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const install = useInstallAgentFromSkillset()

  // Reset during render, not in the install effect: the effect runs after
  // paint, so a dialog reopened after a failure would flash the previous
  // error for a frame.
  const [lastTemplate, setLastTemplate] = useState(template)
  if (template !== lastTemplate) {
    setLastTemplate(template)
    if (template) {
      setPhase('installing')
      setErrorMessage(null)
    }
  }

  // One install per opening. A re-render must not fire a second one, and the
  // ref (not state) is what makes that true even under StrictMode double-invoke.
  const startedFor = useRef<string | null>(null)
  // The parent clears `template` on close, but the content stays mounted
  // through the close animation. Keep showing the last one for that frame.
  const shownRef = useRef<ApiDiscoverableAgent | null>(null)
  if (template) shownRef.current = template
  const shown = shownRef.current

  const run = useCallback(
    async (target: ApiDiscoverableAgent) => {
      let agent: ApiAgentTemplateInstallResult
      try {
        agent = await install.mutateAsync({
          skillsetId: target.skillsetId,
          agentPath: target.path,
          agentName: target.name,
          agentVersion: target.version,
        })
      } catch (error) {
        console.error('Failed to install agent from skillset:', error)
        setErrorMessage(error instanceof Error ? error.message : 'Something went wrong.')
        setPhase('error')
        return
      }
      // Close before onInstalled — that path may open the onboarding
      // "Setting up your agent..." dialog; stacking both looks broken.
      onClose()
      // The dialog is already closed, so its error phase can't render a
      // failure here; the agent itself installed fine, so a toast is the
      // right weight.
      try {
        await onInstalled(agent)
      } catch (error) {
        console.error('Post-install handoff failed:', error)
        toast.error(`${target.name} was installed, but opening it failed.`)
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

  const open = !!template
  const percent = useSimulatedProgress(open && phase === 'installing')
  // The only way to close mid-install is success — complete the bar for the
  // close animation instead of holding wherever the simulation got to.
  const shownPercent = open ? percent : 100

  return (
    <Dialog
      open={open}
      onOpenChange={(nowOpen) => {
        // No dismissing mid-install: the request is already in flight, and a
        // half-installed agent behind a closed dialog is worse than waiting.
        if (!nowOpen && phase !== 'installing') onClose()
      }}
    >
      <StatusDialogContent
        open={open}
        hideClose={phase === 'installing'}
        // The error phase renders a real DialogDescription and must keep
        // Radix's default wiring so screen readers announce the message; the
        // installing phase has none, so suppress the missing-description
        // warning there.
        {...(phase === 'error' ? {} : { 'aria-describedby': undefined })}
      >
        <StatusDialogHeader>
          <StatusDialogTitle shimmer={phase !== 'error'}>
            {phase === 'error' ? `Couldn't install ${shown?.name}` : `Installing ${shown?.name}...`}
          </StatusDialogTitle>
          {phase === 'error' && <DialogDescription>{errorMessage}</DialogDescription>}
        </StatusDialogHeader>

        {phase === 'error' ? (
          <div className="flex justify-center pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : (
          // 21rem = the content width of the original max-w-sm card; the bar
          // keeps that width inside the larger dialog.
          <div
            className="mx-auto flex w-full max-w-[21rem] items-center gap-2.5 pt-2"
            data-testid="template-install-status"
          >
            <span className="sr-only">Installing…</span>
            <Progress percent={shownPercent} className="h-1 flex-1" />
            <span className="text-xs tabular-nums text-muted-foreground">
              {Math.round(shownPercent)}%
            </span>
          </div>
        )}
      </StatusDialogContent>
    </Dialog>
  )
}
