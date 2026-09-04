import { Check, ChevronDown, RotateCcw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Separator } from '@renderer/components/ui/separator'
import { cn } from '@shared/lib/utils/cn'
import { useSettings } from '@renderer/hooks/use-settings'
import { useAgentPreferences, useUpdateAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import {
  AUTO_DELETE_OPTIONS,
  formatAutoDeleteLabel,
} from '@renderer/components/settings/auto-delete-select'
import {
  formatApiLogAutoDeleteLabel,
  isCustomApiLogAutoDeleteValue,
} from '@renderer/components/settings/api-log-auto-delete-select'
import {
  API_LOG_AUTO_DELETE_DAY_OPTIONS,
  DEFAULT_API_LOG_AUTO_DELETE_DAYS,
} from '@shared/lib/config/api-log-auto-delete'

interface HomeRetentionProps {
  agentSlug: string
}

/**
 * The two per-agent retention overrides — session auto-delete and API/MCP
 * log auto-delete — as line items under the Agent Default Model row of the
 * HomeExtras card, with the same trigger + popover shape as that row's model
 * picker. Unset = follow the app-wide default; the popover's footer reverts
 * to it, like the model picker's.
 */
export function HomeRetention({ agentSlug }: HomeRetentionProps) {
  const { data: settings } = useSettings()
  const { data: prefs } = useAgentPreferences(agentSlug)
  const updatePreferences = useUpdateAgentPreferences(agentSlug)

  const sessionOptions = [
    { value: 0, label: 'Never' },
    ...AUTO_DELETE_OPTIONS.map((o) => ({ value: Number(o.value), label: o.label })),
  ]
  const apiLogOptions = [
    { value: 0, label: 'Never' },
    ...API_LOG_AUTO_DELETE_DAY_OPTIONS.map((days) => ({ value: days, label: `${days} days` })),
    // Custom values (e.g. written by the agent via the preferences file hook)
    // are valid but not in the preset list; list them so the current choice
    // is never unmarked.
    ...(isCustomApiLogAutoDeleteValue(prefs?.apiLogAutoDeleteDays)
      ? [{ value: prefs.apiLogAutoDeleteDays, label: `${prefs.apiLogAutoDeleteDays} days` }]
      : []),
  ]

  return (
    <>
      <RetentionRow
        label="Session Auto-Delete"
        testId="home-session-auto-delete"
        options={sessionOptions}
        // 0 is an explicit "Never" override (the app default may be a day
        // count); undefined follows the app default.
        value={prefs?.autoDeleteInactiveDays}
        appDefaultLabel={capitalize(formatAutoDeleteLabel(settings?.app?.autoDeleteInactiveDays))}
        appDefaultShortLabel={shortLabel(settings?.app?.autoDeleteInactiveDays ?? 0)}
        disabled={updatePreferences.isPending}
        onChange={(days) => updatePreferences.mutate({ autoDeleteInactiveDays: days })}
      />
      <RetentionRow
        label="API Log Auto-Delete"
        testId="home-api-log-auto-delete"
        options={apiLogOptions}
        value={prefs?.apiLogAutoDeleteDays}
        appDefaultLabel={capitalize(formatApiLogAutoDeleteLabel(settings?.app?.apiLogAutoDeleteDays))}
        appDefaultShortLabel={shortLabel(settings?.app?.apiLogAutoDeleteDays ?? DEFAULT_API_LOG_AUTO_DELETE_DAYS)}
        disabled={updatePreferences.isPending}
        onChange={(days) => updatePreferences.mutate({ apiLogAutoDeleteDays: days })}
      />
    </>
  )
}

function capitalize(label: string): string {
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`
}

function shortLabel(days: number): string {
  if (days === 0) return 'Never'
  if (days === 365) return '1y'
  return `${days}d`
}

interface RetentionRowProps {
  label: string
  testId: string
  options: { value: number; label: string }[]
  /** The agent's own override; undefined = following the app default. */
  value: number | undefined
  /** Full form for the popover footer ("30 days"). */
  appDefaultLabel: string
  /** Compact form for the trigger ("30d"). */
  appDefaultShortLabel: string
  disabled?: boolean
  /** A number picks an override; null clears it back to the app default. */
  onChange: (days: number | null) => void
}

function RetentionRow({
  label,
  testId,
  options,
  value,
  appDefaultLabel,
  appDefaultShortLabel,
  disabled,
  onChange,
}: RetentionRowProps) {
  const isOverride = value !== undefined
  // The trigger is narrow, so it shows the compact form ("30d", "1y"); the
  // popover options keep their full labels.
  const triggerLabel = isOverride ? shortLabel(value) : appDefaultShortLabel

  return (
    <div className="flex min-h-12 items-center justify-between gap-2 px-4" data-testid={`${testId}-card`}>
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            // Fixed width so the two rows' triggers line up whatever they read.
            className="h-[34px] w-20 justify-between gap-1.5 px-2 text-xs font-medium"
            aria-label={`${label}: ${triggerLabel}. Click to change.`}
            data-testid={`${testId}-trigger`}
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="flex w-56 flex-col px-1 py-2"
          align="end"
          collisionPadding={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex flex-col" role="listbox" aria-label={label}>
            {options.map((option) => {
              const isSelected = isOverride && option.value === value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => onChange(option.value)}
                  data-testid={`${testId}-option-${option.value}`}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground',
                    isSelected ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  <span>{option.label}</span>
                  {isSelected && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                </button>
              )
            })}
          </div>
          <Separator className="my-2 bg-border/50" />
          {/* Disabled = the agent already follows the app-wide default. */}
          <button
            type="button"
            disabled={!isOverride}
            onClick={() => onChange(null)}
            data-testid={`${testId}-app-default`}
            className="flex min-w-0 items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">Reset to Global Default ({appDefaultLabel})</span>
          </button>
        </PopoverContent>
      </Popover>
    </div>
  )
}
