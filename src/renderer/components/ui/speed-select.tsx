import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'
import { cn } from '@shared/lib/utils/cn'

interface SpeedSelectProps {
  value: number
  options: ReadonlyArray<{ value: number; label: string }>
  onChange: (value: number) => void
  /** Accessible name, e.g. "Reading speed". */
  label: string
  title?: string
  testId?: string
  align?: 'start' | 'center'
}

/** A compact "1×" speed picker: a borderless trigger that opens the list of speeds. */
export function SpeedSelect({ value, options, onChange, label, title, testId, align = 'start' }: SpeedSelectProps) {
  return (
    <Select value={String(value)} onValueChange={v => onChange(Number(v))}>
      <SelectTrigger
        aria-label={label}
        title={title}
        data-testid={testId}
        className={cn(
          'h-6 w-auto gap-1 border-0 bg-transparent px-1.5 text-xs text-muted-foreground shadow-none',
          'hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.1] [&>svg]:h-3 [&>svg]:w-3',
        )}
      >
        <SelectValue>{value}×</SelectValue>
      </SelectTrigger>
      <SelectContent align={align}>
        {options.map(o => (
          <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
