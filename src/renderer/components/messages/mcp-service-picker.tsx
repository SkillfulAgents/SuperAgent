import { Check, ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@shared/lib/utils/cn'
import { McpSourceIcon, type RemoteMcpServer } from './mcp-server-card'

export interface McpServicePickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  options: Array<{
    serviceKey: string
    displayName: string
    slug: string
    servers: RemoteMcpServer[]
    hasActiveServer: boolean
  }>
  selectedServiceKey: string
  onSelect: (serviceKey: string, serverId: string) => void
  disabled?: boolean
}

export function McpServicePicker({
  open,
  onOpenChange,
  options,
  selectedServiceKey,
  onSelect,
  disabled,
}: McpServicePickerProps) {
  if (options.length === 0) return null

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <div className="inline-flex items-center gap-1 self-start px-1 py-1 text-xs text-muted-foreground">
        <span>Not the right MCP?</span>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="inline-flex items-center gap-1 transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>Select a different one</span>
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent align="start" side="top" className="w-[320px] max-w-[min(320px,calc(100vw-2rem))] p-1">
        <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
          {options.map((option) => {
            const isSelectedService = option.serviceKey === selectedServiceKey

            return (
              <button
                key={option.serviceKey}
                type="button"
                onClick={() => {
                  onSelect(option.serviceKey, option.servers[0].id)
                  onOpenChange(false)
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left transition-colors',
                  isSelectedService
                    ? 'bg-muted text-foreground'
                    : 'text-foreground hover:bg-muted/60'
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex h-4 w-4 shrink-0 items-center justify-center">
                    <McpSourceIcon slug={option.slug} />
                  </div>
                  <span className="truncate text-sm">{option.displayName}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {option.servers.length} {option.servers.length === 1 ? 'account' : 'accounts'}
                  </span>
                </div>
                <div className="ml-3 flex shrink-0 items-center gap-2">
                  {isSelectedService ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-blue-600" />
                  ) : null}
                </div>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
