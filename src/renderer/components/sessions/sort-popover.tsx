import { useState } from 'react'
import { ArrowUpDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import type { SortOrder } from '@renderer/components/sessions/related-sessions'

interface SortPopoverProps {
  value: SortOrder
  onChange: (next: SortOrder) => void
  ariaLabel: string
}

export function SortPopover({ value, onChange, ariaLabel }: SortPopoverProps) {
  const [open, setOpen] = useState(false)

  const select = (next: SortOrder) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0"
          aria-label={ariaLabel}
        >
          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-40 p-1">
        <button
          className={`flex w-full items-center rounded-sm px-2 py-1.5 text-xs transition-colors ${value === 'newest' ? 'bg-muted font-medium' : 'hover:bg-muted'}`}
          onClick={() => select('newest')}
        >
          Newest first
        </button>
        <button
          className={`flex w-full items-center rounded-sm px-2 py-1.5 text-xs transition-colors ${value === 'oldest' ? 'bg-muted font-medium' : 'hover:bg-muted'}`}
          onClick={() => select('oldest')}
        >
          Oldest first
        </button>
      </PopoverContent>
    </Popover>
  )
}
