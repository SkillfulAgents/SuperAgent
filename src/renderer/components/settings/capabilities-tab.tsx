import { useState, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { PolicyDecisionToggle } from '@renderer/components/ui/policy-decision-toggle'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import type { CapabilityPolicy } from '@shared/lib/config/settings'

const CARD_CLASS = 'rounded-xl border bg-background divide-y divide-border/50 overflow-hidden'
const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'

interface SettingRowProps {
  name: string
  subtitle?: ReactNode
  right: ReactNode
}

function SettingRow({ name, subtitle, right }: SettingRowProps) {
  return (
    <div className="py-3 px-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium truncate">{name}</div>
          {subtitle && (
            <div className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">{right}</div>
      </div>
    </div>
  )
}

export function CapabilitiesTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  // Blocking subagents cripples genuinely useful delegation (browsing,
  // dashboards) — confirm before applying and steer toward review instead.
  const [confirmBlockSubagents, setConfirmBlockSubagents] = useState(false)

  const capabilities = settings?.agentCapabilities ?? { subagents: 'allow', workflows: 'review' }

  const setPolicy = (capability: 'subagents' | 'workflows', policy: CapabilityPolicy) => {
    updateSettings.mutate({ agentCapabilities: { [capability]: policy } })
  }

  const handleSubagentsChange = (value: string) => {
    if (value !== 'allow' && value !== 'review' && value !== 'block') return
    if (value === 'block') {
      setConfirmBlockSubagents(true)
      return
    }
    setPolicy('subagents', value)
  }

  const handleWorkflowsChange = (value: string) => {
    if (value !== 'allow' && value !== 'review' && value !== 'block') return
    setPolicy('workflows', value)
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Launch policies</h3>
        <div className={CARD_CLASS}>
          <SettingRow
            name="Subagents"
            subtitle="Delegated agents launched with the Task tool — browsing, dashboards, research fan-outs. Review pauses each launch for your approval; Block removes the capability entirely."
            right={
              <div data-testid="capability-policy-subagents" className={isLoading ? 'pointer-events-none opacity-50' : undefined}>
                <PolicyDecisionToggle
                  value={capabilities.subagents}
                  onChange={handleSubagentsChange}
                  allowDeselect={false}
                />
              </div>
            }
          />
          <SettingRow
            name="Workflows"
            subtitle="Multi-agent orchestrations launched with the Workflow tool. A single workflow can fan out into dozens of agents, so these default to Review."
            right={
              <div data-testid="capability-policy-workflows" className={isLoading ? 'pointer-events-none opacity-50' : undefined}>
                <PolicyDecisionToggle
                  value={capabilities.workflows}
                  onChange={handleWorkflowsChange}
                  allowDeselect={false}
                />
              </div>
            }
          />
        </div>
        <p className="px-1 text-[11px] text-muted-foreground leading-relaxed">
          Policies apply to every agent. Under Review, approving with &ldquo;Allow for this session&rdquo; stops
          repeat prompts within that conversation. Changes take effect from each session&apos;s next message.
        </p>
      </div>

      <AlertDialog open={confirmBlockSubagents} onOpenChange={setConfirmBlockSubagents}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Block subagents everywhere?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Subagents power core features — web browsing, dashboard building, and desktop
              automation all delegate to them. Blocking removes those abilities from every agent.
              If cost control is the goal, <span className="font-medium text-foreground">Review</span> keeps
              the capability while letting you approve each launch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="block-subagents-cancel">Keep current setting</AlertDialogCancel>
            <AlertDialogAction
              data-testid="block-subagents-use-review"
              onClick={() => setPolicy('subagents', 'review')}
            >
              Use Review instead
            </AlertDialogAction>
            <AlertDialogAction
              data-testid="block-subagents-confirm"
              className="bg-orange-600 text-white hover:bg-orange-700"
              onClick={() => setPolicy('subagents', 'block')}
            >
              Block anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
