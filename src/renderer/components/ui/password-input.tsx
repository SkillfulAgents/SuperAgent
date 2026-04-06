import { useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Eye, EyeOff } from 'lucide-react'

interface PasswordInputProps extends Omit<React.ComponentProps<typeof Input>, 'type'> {
  /** Controlled show/hide state. When omitted, managed internally. */
  show?: boolean
  onShowChange?: (show: boolean) => void
}

export function PasswordInput({ show: controlledShow, onShowChange, ...props }: PasswordInputProps) {
  const [internalShow, setInternalShow] = useState(false)
  const showValue = controlledShow ?? internalShow
  const toggleShow = () => {
    const next = !showValue
    setInternalShow(next)
    onShowChange?.(next)
  }

  return (
    <div className="relative">
      <Input
        {...props}
        type={showValue ? 'text' : 'password'}
        className={`pr-10 ${props.className ?? ''}`}
      />
      <button
        type="button"
        onClick={toggleShow}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        disabled={props.disabled}
      >
        {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}
