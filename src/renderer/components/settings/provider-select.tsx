import { useId, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Separator } from '@renderer/components/ui/separator'
import type { ConnectionInfo } from '@shared/lib/llm-provider/connection-schema'
import { ProviderLogo } from './provider-logo'
import { ProviderUsage } from './provider-usage'

export function ProviderSelect({ connections: unordered, value, onChange, directApiOnly, disabled }: {
  connections: ConnectionInfo[]
  value?: string | null
  onChange: (id: string) => void
  directApiOnly?: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  // Platform always leads; everything else keeps its server order (sort is stable).
  const connections = [...unordered].sort((a, b) => Number(b.provider === 'platform') - Number(a.provider === 'platform'))
  // Rows expand on highlight. Collapsing a row ABOVE the pointer would shift the
  // next target out from under it, so those stay open until the pointer leaves
  // the list; rows below collapse at once, which never moves the target.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const expandAt = (index: number) => setExpanded(ids => new Set([
    ...connections.slice(0, index).map(c => c.id).filter(id => ids.has(id)),
    connections[index].id,
  ]))
  if (connections.length < 2) return null
  const selected = connections.find(c => c.id === value)
  const label = (c: ConnectionInfo) => `${c.name}${c.userId ? ` · ${c.ownerName ?? 'Personal'}` : ''}`
  return (
    <>
      <div className="mx-1 flex text-xs">
        <Select open={open} onOpenChange={next => { setOpen(next); if (!next) setExpanded(new Set()) }} value={value ?? ''} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger aria-label="Connection" className="h-auto w-auto max-w-full justify-start gap-1 border-0 px-1 py-1 font-medium shadow-none hover:bg-accent focus:ring-0 focus-visible:ring-1 [&>svg]:text-foreground [&>svg]:opacity-100">
            <SelectValue placeholder="Choose provider">{selected ? <ConnectionName connection={selected} label={label(selected)} /> : undefined}</SelectValue>
          </SelectTrigger>
          <SelectContent position="popper" className="min-w-72 max-w-[22rem]" onPointerLeave={() => setExpanded(new Set())}>
            {connections.map((connection, index) => (
              <ProviderOption key={connection.id} connection={connection} label={label(connection)} open={open}
                expanded={expanded.has(connection.id)} onExpand={() => expandAt(index)}
                disabled={directApiOnly && connection.supportsDirectApi === false} />
            ))}
          </SelectContent>
        </Select>
      </div>
      <Separator className="mb-2 mt-1 bg-border/50" />
    </>
  )
}

function ProviderOption({ connection, label, open, expanded, onExpand, disabled }: {
  connection: ConnectionInfo; label: string; open: boolean; expanded: boolean; onExpand: () => void; disabled?: boolean
}) {
  const descriptionId = useId()
  return (
    <SelectItem value={connection.id} textValue={label} aria-label={label} aria-describedby={open ? descriptionId : undefined}
      disabled={disabled} className="mb-0.5 items-start flex-col py-2.5 pr-2 last:mb-0 data-[state=checked]:bg-accent"
      // Radix focuses an item when it is highlighted (hover or arrow keys).
      onFocus={onExpand}
      description={open ? (
        <span data-expanded={expanded || undefined} className={`grid w-full transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
          <span className="min-h-0 overflow-hidden"><ProviderUsage connection={connection} compact descriptionId={descriptionId} /></span>
        </span>
      ) : undefined}>
      {/* Only the name clears the trailing check; usage rows span the full width. */}
      <ConnectionName connection={connection} label={label} className="pr-6" />
    </SelectItem>
  )
}

function ConnectionName({ connection, label, className }: { connection: ConnectionInfo; label: string; className?: string }) {
  return (
    <span className={`flex min-w-0 items-center gap-1.5 font-medium ${className ?? ''}`}>
      <ProviderLogo provider={connection.provider} className="h-3.5 w-3.5" monochrome />
      <span className="truncate">{label}</span>
    </span>
  )
}
