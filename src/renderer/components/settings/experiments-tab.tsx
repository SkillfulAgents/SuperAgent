import { FlaskConical } from 'lucide-react'
import { Switch } from '@renderer/components/ui/switch'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { experimentEnabled, listExperiments } from '@shared/lib/experiments'

const CARD_CLASS = 'rounded-xl border bg-background divide-y divide-border/50 overflow-hidden'
const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'

/**
 * Settings → Experiments: one switch per entry in the experiments registry.
 * Each switch is the viewer's own; nobody else's app changes.
 */
export function ExperimentsTab() {
  const { data: userSettings, isLoading } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()
  const experiments = listExperiments()

  return (
    <div className="space-y-6">
      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
        Features that are still being built. They may change or go away. Turning one on affects only you.
      </p>

      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Experiments</h3>
        <div className={CARD_CLASS}>
          {experiments.length === 0 ? (
            <div className="flex items-center gap-2 px-4 py-3 text-[11px] text-muted-foreground" data-testid="experiments-empty">
              <FlaskConical className="h-3.5 w-3.5 shrink-0" />
              No experiments right now.
            </div>
          ) : (
            experiments.map((experiment) => {
              const switchId = `experiment-${experiment.id}`
              return (
                <div key={experiment.id} className="px-4 py-3" data-testid={`experiment-row-${experiment.id}`}>
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <label htmlFor={switchId} className="block cursor-default truncate text-xs font-medium">
                        {experiment.name}
                      </label>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{experiment.description}</div>
                    </div>
                    <Switch
                      id={switchId}
                      checked={experimentEnabled(userSettings?.experiments, experiment.id)}
                      onCheckedChange={(checked: boolean) => {
                        updateUserSettings.mutate({ experiments: { [experiment.id]: checked } })
                      }}
                      disabled={isLoading}
                      data-testid={`experiment-switch-${experiment.id}`}
                    />
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
