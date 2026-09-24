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
  if (connections.length < 2) return null
  const selected = connections.find(c => c.id === value)
  const label = (c: ConnectionInfo) => `${c.name}${c.userId ? ` · ${c.ownerName ?? 'Personal'}` : ''}`
  return (
    <div className="mx-1 mb-1 text-xs">
      <Select value={value ?? ''} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label="Connection" className="h-auto border-0 px-1 py-1 shadow-none">
          <SelectValue placeholder="Choose provider">{selected ? label(selected) : undefined}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" className="min-w-64 max-w-80">
          {connections.map(connection => (
            <SelectItem key={connection.id} value={connection.id} textValue={label(connection)}
              disabled={directApiOnly && connection.supportsDirectApi === false} className="items-start py-2 [&>span:last-child]:w-full">
              <span className="block truncate font-medium">{label(connection)}</span>
              <ProviderUsage connection={connection} compact />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
