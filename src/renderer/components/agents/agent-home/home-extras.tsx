import { useCallback } from 'react'
import { ChevronRight } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { isElectron } from '@renderer/lib/env'

interface HomeExtrasProps {
  agentSlug: string
  onOpenSettings?: (tab?: string) => void
}

export function HomeExtras({ agentSlug, onOpenSettings }: HomeExtrasProps) {
  const handleOpenDirectory = useCallback(async () => {
    const res = await apiFetch(`/api/agents/${agentSlug}/open-directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ open: isElectron() }),
    })
    if (!isElectron() && res.ok) {
      const { path } = await res.json()
      try {
        await navigator.clipboard.writeText(path)
      } catch {
        // Clipboard write may fail in non-secure contexts; silently ignore
      }
    }
  }, [agentSlug])

  return (
    <div className="rounded-xl border bg-background py-2">
      <div className="divide-y divide-border/50">
        <button
          onClick={() => onOpenSettings?.('system-prompt')}
          className="flex w-full items-center justify-between py-3 px-4 text-left hover:bg-muted/50 transition-colors"
        >
          <span className="text-sm font-medium text-muted-foreground">System Prompt</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>
        <button
          onClick={handleOpenDirectory}
          className="flex w-full items-center justify-between py-3 px-4 text-left hover:bg-muted/50 transition-colors"
        >
          <span className="text-sm font-medium text-muted-foreground">Agent Directory</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>
        <button
          onClick={() => onOpenSettings?.('secrets')}
          className="flex w-full items-center justify-between py-3 px-4 text-left hover:bg-muted/50 transition-colors"
        >
          <span className="text-sm font-medium text-muted-foreground">Secrets</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>
        <button
          onClick={() => onOpenSettings?.('audit-log')}
          className="flex w-full items-center justify-between py-3 px-4 text-left hover:bg-muted/50 transition-colors"
        >
          <span className="text-sm font-medium text-muted-foreground">API Logs</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
    </div>
  )
}
