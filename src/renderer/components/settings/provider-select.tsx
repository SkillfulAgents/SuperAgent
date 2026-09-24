import { useId, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import type { ConnectionInfo } from '@shared/lib/llm-provider/connection-schema'
import { ProviderUsage } from './provider-usage'

export function ProviderSelect({ connections, value, onChange, directApiOnly, disabled }: {
  connections: ConnectionInfo[]
  value?: string | null
  onChange: (id: string) => void
  directApiOnly?: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (connections.length < 2) return null
  const selected = connections.find(c => c.id === value)
  const label = (c: ConnectionInfo) => `${c.name}${c.userId ? ` · ${c.ownerName ?? 'Personal'}` : ''}`
  return (
    <div className="mx-1 mb-1 text-xs">
      <Select open={open} onOpenChange={setOpen} value={value ?? ''} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label="Connection" className="h-auto border-0 px-1 py-1 shadow-none">
          <SelectValue placeholder="Choose provider">{selected ? label(selected) : undefined}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" className="min-w-64 max-w-80">
          {connections.map(connection => (
            <ProviderOption key={connection.id} connection={connection} label={label(connection)} open={open}
              disabled={directApiOnly && connection.supportsDirectApi === false} />
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function ProviderOption({ connection, label, open, disabled }: {
  connection: ConnectionInfo; label: string; open: boolean; disabled?: boolean
}) {
  const descriptionId = useId()
  return (
    <SelectItem value={connection.id} textValue={label} aria-label={label} aria-describedby={open ? descriptionId : undefined}
      disabled={disabled} className="items-start flex-col py-2 [&>span:last-child]:w-full"
      description={open ? <ProviderUsage connection={connection} compact descriptionId={descriptionId} /> : undefined}>
      <span className="block truncate font-medium">{label}</span>
    </SelectItem>
  )
}
