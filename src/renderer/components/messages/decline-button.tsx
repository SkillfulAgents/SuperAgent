import { useState, useRef } from 'react'
import { X, ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@renderer/components/ui/popover'
import { cn } from '@shared/lib/utils/cn'

interface DeclineButtonProps {
  onDecline: (reason?: string) => void
  disabled?: boolean
  className?: string
  'data-testid'?: string
}

export function DeclineButton({ onDecline, disabled, className, 'data-testid': testId }: DeclineButtonProps) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="flex items-stretch">
      <Button
        onClick={() => onDecline()}
        disabled={disabled}
        variant="outline"
        size="sm"
        className={cn('rounded-r-none border-r-0', className)}
        data-testid={testId}
      >
        <X className="h-4 w-4" />
        <span className="ml-1">Decline</span>
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            disabled={disabled}
            variant="outline"
            size="sm"
            className={cn('rounded-l-none px-1.5', className)}
            data-testid={testId ? `${testId}-chevron` : undefined}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-64 p-3 space-y-2"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            inputRef.current?.focus()
          }}
          onCloseAutoFocus={() => setReason('')}
        >
          <p className="text-sm font-medium">Decline with reason</p>
          <input
            ref={inputRef}
            type="text"
            placeholder="Reason for declining..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-md border px-2 py-1.5 text-sm bg-background"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && reason.trim()) {
                onDecline(reason.trim())
                setOpen(false)
              }
            }}
          />
          <Button
            onClick={() => {
              onDecline(reason.trim() || undefined)
              setOpen(false)
            }}
            size="sm"
            variant="outline"
            className="w-full"
          >
            Decline
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  )
}
