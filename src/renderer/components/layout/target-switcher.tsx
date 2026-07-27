import { Cloud, Laptop } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { useTargetSwitch } from '@renderer/hooks/use-target-switch'
import type { ApiTarget } from '@renderer/lib/api-target'

/**
 * Chooses which Superagent this app drives: the one on this computer, or the
 * organization's cloud workspace.
 *
 * Hidden entirely when there is no cloud workspace to switch to, so a
 * single-machine user never sees a control with one option.
 */

const options: { value: ApiTarget; icon: typeof Laptop; label: string; title: string }[] = [
  {
    value: 'local',
    icon: Laptop,
    label: 'This computer',
    title: 'Run agents on this computer',
  },
  {
    value: 'cloud',
    icon: Cloud,
    label: 'Cloud',
    title: "Run agents on your organization's cloud workspace",
  },
]

export function TargetSwitcher() {
  const { current, available, switching, switchTo } = useTargetSwitch()

  if (!available) return null

  return (
    // Own the surrounding padding rather than taking it from a wrapper at the
    // call site: this renders nothing most of the time, and a wrapper would
    // leave a stray padded div in every local-only sidebar.
    <div className="px-2 pb-2">
      <div
        className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5"
        role="group"
        aria-label="Where agents run"
        data-testid="target-switcher"
      >
        {options.map(({ value, icon: Icon, label, title }) => {
          const active = value === current
          return (
            <button
              key={value}
              type="button"
              title={title}
              aria-pressed={active}
              disabled={switching}
              data-testid={`target-option-${value}`}
              onClick={() => void switchTo(value)}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs transition-colors',
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
                switching && 'cursor-wait opacity-60',
              )}
            >
              <Icon className="size-3" />
              <span className="truncate">{label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
