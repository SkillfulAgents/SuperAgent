import { useState, useRef } from 'react'
import { X, ChevronDown, ArrowUp } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@renderer/components/ui/popover'
import { cn } from '@shared/lib/utils/cn'

interface DeclineButtonProps {
  onDecline: (reason?: string) => void
  disabled?: boolean
  className?: string
  label?: string
  showIcon?: boolean
  'data-testid'?: string
}

export function DeclineButton({
  onDecline,
  disabled,
  className,
  label = 'Decline',
  showIcon = true,
  'data-testid': testId
}: DeclineButtonProps) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const placeholderVerb =
    label === 'Dismiss' ? 'dismissing' : label === 'Deny' ? 'denying' : label === 'Decline' ? 'declining' : label.toLowerCase()

  const headerCopy = `Tell your agent why you want to ${label.toLowerCase()}`

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
        {showIcon ? <X className="h-4 w-4" /> : null}
        <span className={showIcon ? 'ml-1' : undefined}>{label}</span>
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
          className="w-80 p-0"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            requestAnimationFrame(() => {
              inputRef.current?.focus()
            })
          }}
          onCloseAutoFocus={() => setReason('')}
        >
          <div className="w-full p-3 pt-2">
            <div className="w-full text-foreground">
              <span className="flex flex-col items-start text-left">
                <span className="text-xs font-medium text-foreground">{headerCopy}</span>
              </span>
            </div>
            <div className="mt-2 flex min-h-10 gap-2 rounded-md border border-border bg-background pl-3 pr-0 pb-1">
              <textarea
                ref={inputRef}
                placeholder={`Reason for ${placeholderVerb}...`}
                value={reason}
                rows={1}
                onChange={(e) => {
                  setReason(e.target.value)
                  e.currentTarget.style.height = 'auto'
                  e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`
                }}
                className="flex-1 self-center resize-none overflow-hidden bg-transparent px-0 py-2 text-xs placeholder:text-xs placeholder:text-muted-foreground/80 focus:outline-none focus:ring-0"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    onDecline(reason.trim() || undefined)
                    setOpen(false)
                  }
                }}
              />
              <Button
                type="button"
                size="icon"
                disabled={disabled}
                onClick={() => {
                  onDecline(reason.trim() || undefined)
                  setOpen(false)
                }}
                className="mr-1 h-8 w-8 shrink-0 self-end rounded-md border border-border bg-foreground text-background hover:bg-foreground/90"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
