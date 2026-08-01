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
 *
 * Sits in the sidebar's title-bar row, which is a fixed 48px shared with the
 * traffic lights and the history/search buttons — so it shows icons only and
 * reveals its labels on hover, rather than permanently spending the width two
 * words need. The labels stay in the DOM at every size (they are the accessible
 * names); only their box collapses.
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
    // `app-no-drag`: this lives in the window's drag region, where a plain
    // button would move the window instead of being pressed.
    <div
      className="group/target app-no-drag flex shrink-0 items-center gap-0.5 rounded-md bg-muted/60 p-0.5"
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
              // Expanded, this control has to fit the narrowest sidebar (288)
              // less the inset, the traffic-light reservation, and the row's
              // left padding — 184px of visible room, against ~177 for the two
              // options and their labels. There is about 7px of slack, so a
              // wider label or more padding here clips the pill at the default
              // width, where nobody can drag it narrower to reproduce.
              'flex items-center justify-center rounded px-1.5 py-1 text-xs transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
              switching && 'cursor-wait opacity-60',
            )}
          >
            <Icon className="size-3.5 shrink-0" />
            {/* A single-column grid animated between 0fr and 1fr: the label's own
                width is the target, so nothing here has to guess how wide two
                translated words are. `overflow-hidden` on the clipping span is
                what lets the column actually reach zero (a grid item's automatic
                minimum size is its content unless it clips). Focus-within opens
                it too — a keyboard user never hovers, and would otherwise meet
                two unlabelled icons.

                The gap between icon and label is padding on the *inner* span,
                inside the clip. Put it on the clipping span instead and it
                survives the collapse — box-sizing cannot shrink a box below its
                own padding — leaving 6px of dead space that shoves every icon
                off the centre of its button. */}
            <span className="grid grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-out group-hover/target:grid-cols-[1fr] group-focus-within/target:grid-cols-[1fr]">
              <span className="overflow-hidden">
                <span className="block whitespace-nowrap pl-1.5">{label}</span>
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
