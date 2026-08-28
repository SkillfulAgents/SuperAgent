import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import {
  API_LOG_AUTO_DELETE_DAY_OPTIONS,
  DEFAULT_API_LOG_AUTO_DELETE_DAYS,
} from '@shared/lib/config/api-log-auto-delete'

export function formatApiLogAutoDeleteLabel(days: number | undefined): string {
  if (days === 0) return 'never'
  if (days && days > 0) return `${days} days`
  return `${DEFAULT_API_LOG_AUTO_DELETE_DAYS} days`
}

// Custom values (e.g. written by the agent via the preferences file hook) are
// valid but not in the preset list; render them so the trigger isn't blank.
function isCustomValue(days: number | undefined): days is number {
  return (
    days !== undefined &&
    days > 0 &&
    !API_LOG_AUTO_DELETE_DAY_OPTIONS.some((o) => o === days)
  )
}

interface ApiLogAutoDeleteSelectProps {
  value: number | undefined
  onChange: (days: number) => void
  disabled?: boolean
}

export function ApiLogAutoDeleteSelect({ value, onChange, disabled }: ApiLogAutoDeleteSelectProps) {
  return (
    <Select
      value={(value ?? DEFAULT_API_LOG_AUTO_DELETE_DAYS).toString()}
      onValueChange={(val) => onChange(parseInt(val, 10))}
      disabled={disabled}
    >
      <SelectTrigger className="h-8 w-[140px]" aria-label="API log auto-delete">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="0">Never</SelectItem>
        {API_LOG_AUTO_DELETE_DAY_OPTIONS.map((days) => (
          <SelectItem key={days} value={days.toString()}>
            {days} days
          </SelectItem>
        ))}
        {isCustomValue(value) && (
          <SelectItem value={value.toString()}>{value} days</SelectItem>
        )}
      </SelectContent>
    </Select>
  )
}

interface AgentApiLogAutoDeleteSelectProps {
  value: number | undefined
  appDefault: number | undefined
  onChange: (days: number | null) => void
}

export function AgentApiLogAutoDeleteSelect({
  value,
  appDefault,
  onChange,
}: AgentApiLogAutoDeleteSelectProps) {
  return (
    <Select
      value={value === undefined ? 'default' : value.toString()}
      onValueChange={(val) => {
        onChange(val === 'default' ? null : parseInt(val, 10))
      }}
    >
      <SelectTrigger className="w-48" aria-label="API log auto-delete">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">
          App default ({formatApiLogAutoDeleteLabel(appDefault)})
        </SelectItem>
        <SelectItem value="0">Never</SelectItem>
        {API_LOG_AUTO_DELETE_DAY_OPTIONS.map((days) => (
          <SelectItem key={days} value={days.toString()}>
            {days} days
          </SelectItem>
        ))}
        {isCustomValue(value) && (
          <SelectItem value={value.toString()}>{value} days</SelectItem>
        )}
      </SelectContent>
    </Select>
  )
}
