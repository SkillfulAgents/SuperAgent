import { useState, type ReactNode } from 'react'
import { ArrowUpRight, ChevronRight, Copy } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { isElectron } from '@renderer/lib/env'

interface HomeExtrasProps {
  agentSlug: string
  onOpenSettings?: (tab?: string) => void
}

export function HomeExtras({ agentSlug, onOpenSettings }: HomeExtrasProps) {
  const [error, setError] = useState<string | null>(null)

  const handleOpenDirectory = async () => {
    setError(null)
    try {
      const res = await apiFetch(`/api/agents/${agentSlug}/open-directory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ open: isElectron() }),
      })
      if (!res.ok) throw new Error('Failed to open agent directory')
      if (!isElectron()) {
        const { path } = await res.json()
        try {
          await navigator.clipboard.writeText(path)
        } catch {
          setError(`Clipboard blocked. Path: ${path}`)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open agent directory')
    }
  }

  const directoryHoverIcon = isElectron() ? (
    <ArrowUpRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
  ) : (
    <Copy className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
  )
  const directoryLabel = isElectron() ? 'Agent Directory' : 'Copy Agent Path'

  return (
    <div className="rounded-xl border bg-background py-2">
      <div className="divide-y divide-border/50">
        <ExtrasButton label="System Prompt" onClick={() => onOpenSettings?.('system-prompt')} />
        <ExtrasButton label={directoryLabel} onClick={handleOpenDirectory} hoverIcon={directoryHoverIcon} />
        <ExtrasButton label="Secrets" onClick={() => onOpenSettings?.('secrets')} />
        <ExtrasButton label="API Logs" onClick={() => onOpenSettings?.('audit-log')} />
      </div>
      {error && (
        <p className="px-4 pt-2 text-[11px] text-destructive" role="alert">{error}</p>
      )}
    </div>
  )
}

function ExtrasButton({ label, onClick, hoverIcon }: { label: string; onClick: () => void; hoverIcon?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center justify-between py-3 px-4 text-left hover:bg-muted/50 transition-colors"
    >
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      {hoverIcon ? (
        <span className="relative h-4 w-4">
          <ChevronRight
            className="absolute inset-0 h-4 w-4 text-muted-foreground transition-opacity group-hover:opacity-0"
            aria-hidden="true"
          />
          <span className="absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100">
            {hoverIcon}
          </span>
        </span>
      ) : (
        <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      )}
    </button>
  )
}
