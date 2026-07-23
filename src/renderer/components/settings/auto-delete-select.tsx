import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'

const AUTO_DELETE_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
] as const

export function formatAutoDeleteLabel(days: number | undefined): string {
  const option = AUTO_DELETE_OPTIONS.find((o) => o.value === String(days))
  if (option) return option.label
  if (days && days > 0) return `${days} days`
  return 'never'
}

interface AutoDeleteSelectProps {
  value: number | undefined
  onChange: (days: number) => void
  disabled?: boolean
}

export function AutoDeleteSelect({ value, onChange, disabled }: AutoDeleteSelectProps) {
  return (
    <Select
      value={(value ?? 0).toString()}
      onValueChange={(val) => onChange(parseInt(val, 10))}
      disabled={disabled}
    >
      <SelectTrigger className="h-8 w-[140px] text-xs" aria-label="Session auto-delete">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="0" className="text-xs">Never</SelectItem>
        {AUTO_DELETE_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} className="text-xs">
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

interface AgentAutoDeleteSelectProps {
  value: number | undefined
  appDefault: number | undefined
  onChange: (days: number | null) => void
}

export function AgentAutoDeleteSelect({
  value,
  appDefault,
  onChange,
}: AgentAutoDeleteSelectProps) {
  return (
    <Select
      value={value?.toString() ?? 'default'}
      onValueChange={(val) => {
        onChange(val === 'default' ? null : parseInt(val, 10))
      }}
    >
      <SelectTrigger className="w-48" aria-label="Session auto-delete">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">
          App default ({formatAutoDeleteLabel(appDefault)})
        </SelectItem>
        {AUTO_DELETE_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
