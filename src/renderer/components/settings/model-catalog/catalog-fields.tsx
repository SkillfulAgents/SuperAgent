import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'

interface CurrencyPriceInputProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  testId?: string
  disabled?: boolean
}

/** A `$`-prefixed numeric price field with a "USD per million tokens" hint. */
export function CurrencyPriceInput({
  id,
  label,
  value,
  onChange,
  testId,
  disabled,
}: CurrencyPriceInputProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-foreground">{label}</Label>
      <div className="relative">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
        >
          $
        </span>
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          aria-describedby={`${id}-unit`}
          data-testid={testId}
          disabled={disabled}
          className="h-8 pl-7 text-xs"
        />
      </div>
      <div id={`${id}-unit`} className="text-[11px] text-muted-foreground">USD per million tokens</div>
    </div>
  )
}

interface LabeledTextInputProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
}

/** A small labeled single-line text field. */
export function LabeledTextInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: LabeledTextInputProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-foreground">{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="h-8 text-xs"
      />
    </div>
  )
}
