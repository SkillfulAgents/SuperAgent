import { type ReactNode } from 'react'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { useUpdateChatIntegration } from '@renderer/hooks/use-chat-integrations'
import { SettingsModelSelect } from '@renderer/components/settings/settings-model-select'
import type { EffortLevel } from '@shared/lib/container/types'
import type { ChatIntegration } from '@shared/lib/db/schema'

export function ToggleRow({ label, helperText, checked, onCheckedChange, disabled }: {
  label: string
  helperText?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex w-full items-center justify-between px-4 py-3">
      <div className={helperText ? 'flex flex-col gap-0.5' : undefined}>
        <span className="text-xs">{label}</span>
        {helperText && <span className="text-xs text-muted-foreground/70">{helperText}</span>}
      </div>
      <Switch
        className="scale-75 origin-right"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}

/**
 * Inline setting row: label (+ optional short description) on the left, control
 * on the right. Mirrors {@link ToggleRow}'s layout so selects and toggles line up.
 */
export function SettingRow({ label, description, htmlFor, children }: {
  label: string
  description?: string
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="flex w-full items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={htmlFor} className="text-xs font-normal">{label}</Label>
        {description && <span className="text-xs text-muted-foreground/70">{description}</span>}
      </div>
      {children}
    </div>
  )
}

// Idle-timeout presets (hours). `never` keeps a single rolling conversation.
const TIMEOUT_OPTIONS: { value: string; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: '1', label: '1 hour' },
  { value: '6', label: '6 hours' },
  { value: '12', label: '12 hours' },
  { value: '24', label: '1 day' },
  { value: '72', label: '3 days' },
  { value: '168', label: '1 week' },
]

function formatTimeoutHours(hours: number): string {
  if (hours % 168 === 0) { const w = hours / 168; return `${w} week${w > 1 ? 's' : ''}` }
  if (hours % 24 === 0) { const d = hours / 24; return `${d} day${d > 1 ? 's' : ''}` }
  return `${hours} hour${hours > 1 ? 's' : ''}`
}

const TIMEOUT_LABEL = 'Start new conversation after inactivity'

export function SessionTimeoutSelect({ value, onCommit, disabled, id, description, layout = 'stacked', wrapperClassName = 'px-4 py-3' }: {
  value: number | null
  onCommit: (hours: number | null) => void
  disabled?: boolean
  id: string
  /** Short helper text shown under the label (inline layout only). */
  description?: string
  /** `inline` puts the label/control on one row (settings card); `stacked` keeps the label above (setup dialog). */
  layout?: 'inline' | 'stacked'
  /** Override the row padding for the stacked layout (the setup dialog passes its own). */
  wrapperClassName?: string
}) {
  const current = value != null && value > 0 ? String(value) : 'never'
  // Keep an existing custom (non-preset) value selectable.
  const options = TIMEOUT_OPTIONS.some((o) => o.value === current)
    ? TIMEOUT_OPTIONS
    : [...TIMEOUT_OPTIONS, { value: current, label: formatTimeoutHours(value as number) }]

  const select = (
    <Select
      value={current}
      disabled={disabled}
      onValueChange={(v) => onCommit(v === 'never' ? null : parseInt(v, 10))}
    >
      <SelectTrigger id={id} className={layout === 'inline' ? 'h-7 w-24 shrink-0 text-xs' : 'h-7 text-xs'}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  if (layout === 'inline') {
    return (
      <SettingRow label={TIMEOUT_LABEL} description={description} htmlFor={id}>
        {select}
      </SettingRow>
    )
  }

  return (
    <div className={wrapperClassName}>
      <Label htmlFor={id} className="text-xs font-normal mb-1 block">
        {TIMEOUT_LABEL}
      </Label>
      {select}
    </div>
  )
}

export function IntegrationModelEffort({ integration }: { integration: ChatIntegration }) {
  const updateIntegration = useUpdateChatIntegration()

  // Drive directly off the integration; useUpdateChatIntegration invalidates the
  // detail query, so an edit (or an integration switch) flows back through props -
  // a local mirror would go stale when the same component renders another chat.
  return (
    <SettingsModelSelect
      model={integration.model ?? undefined}
      onModelChange={(m) => updateIntegration.mutate({ id: integration.id, model: m })}
      includeEffort
      effort={(integration.effort as EffortLevel) ?? 'medium'}
      onEffortChange={(e) => updateIntegration.mutate({ id: integration.id, effort: e })}
    />
  )
}
