import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Progress } from '@renderer/components/ui/progress'
import { statusDialogAnimation, StatusDialogMatrix } from '@renderer/components/agents/status-dialog-style'
import { useInstallAgentFromSkillset } from '@renderer/hooks/use-agent-templates'
import type { ApiAgentTemplateInstallResult, ApiDiscoverableAgent } from '@shared/lib/types/api'

type Phase = 'installing' | 'error'

interface TemplateInstallDialogProps {
  template: ApiDiscoverableAgent | null
  onClose: () => void
  /** Called after the agent is fully installed. */
  onInstalled: (agent: ApiAgentTemplateInstallResult) => void | Promise<void>
}

interface TemplateInstallDialogViewProps {
  open: boolean
  phase: Phase
  name?: string
  errorMessage?: string | null
  /** Dismiss handler. Pass null to make the dialog undismissable (install in flight). */
  onDismiss: (() => void) | null
}

/**
 * Paced install progress. The install request emits no progress events, so the
 * bar eases toward 90% and holds; the dialog closes the moment the request
 * lands, so it never needs to reach 100.
 */
function useSimulatedProgress(active: boolean) {
  const [percent, setPercent] = useState(0)
  useEffect(() => {
    if (!active) {
      setPercent(0)
      return
    }
    const startedAt = performance.now()
    const id = window.setInterval(() => {
      const seconds = (performance.now() - startedAt) / 1000
      setPercent(90 * (1 - Math.exp(-seconds / 4)))
    }, 150)
    return () => window.clearInterval(id)
  }, [active])
  return percent
}

/** Pure presentation for the install dialog. */
function TemplateInstallDialogView({
  open,
  phase,
  name,
  errorMessage,
  onDismiss,
}: TemplateInstallDialogViewProps) {
  const percent = useSimulatedProgress(open && phase === 'installing')
  return (
    <Dialog
      open={open}
      onOpenChange={(nowOpen) => {
        if (!nowOpen) onDismiss?.()
      }}
    >
      {/* hideClose keys off phase, not onDismiss, so the dev preview of the
          installing state looks exactly like the real (undismissable) one —
          there Escape is still available via onDismiss. */}
      <DialogContent
        className="max-w-lg min-h-72 content-center"
        style={statusDialogAnimation.contentStyle}
        hideClose={phase === 'installing'}
        overlayClassName={statusDialogAnimation.overlay}
        overlayStyle={statusDialogAnimation.overlayStyle}
        aria-describedby={undefined}
      >
        <StatusDialogMatrix />
        {/* sm:text-center beats the base header's sm:text-left so multi-line
            descriptions (e.g. error messages) stay centered at all widths. */}
        <DialogHeader className="items-center text-center sm:text-center">
          <DialogTitle
            className={
              phase === 'error'
                ? 'text-base font-normal'
                : 'status-title-shimmer text-base font-normal'
            }
          >
            {phase === 'error' ? `Couldn't install ${name}` : `Installing ${name}...`}
          </DialogTitle>
          {phase === 'error' && <DialogDescription>{errorMessage}</DialogDescription>}
        </DialogHeader>

        {phase !== 'error' && (
          // 21rem = the content width of the original max-w-sm card; the bar
          // keeps that width inside the larger dialog.
          <div
            className="mx-auto flex w-full max-w-[21rem] items-center gap-2.5 pt-2"
            data-testid="template-install-status"
          >
            <span className="sr-only">Installing…</span>
            <Progress percent={percent} className="h-1 flex-1" />
            <span className="text-xs tabular-nums text-muted-foreground">
              {Math.round(percent)}%
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
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
    <TemplateInstallDialogView
      open={!!template}
      phase={phase}
      name={shown?.name}
      errorMessage={errorMessage}
      // No dismissing mid-install: the request is already in flight, and a
      // half-installed agent behind a closed dialog is worse than waiting.
      onDismiss={phase === 'installing' ? null : onClose}
    />
  )
}
