import { Download } from 'lucide-react'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

export interface TemplateCardProps {
  template: ApiDiscoverableAgent
  onClick: () => void
  /** `full` shows skillset name (HomePage grid); `compact` omits it (wizard grouped grid). */
  variant?: 'full' | 'compact'
}

export function TemplateCard({ template, onClick, variant = 'full' }: TemplateCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        variant === 'full'
          ? 'text-left p-4 rounded-lg border border-dashed bg-card hover:bg-accent/50 transition-colors flex flex-col gap-2'
          : 'text-left rounded-lg border p-3 opacity-70 hover:opacity-100 focus-visible:opacity-100 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-all'
      }
    >
      <div className="flex items-center gap-2">
        <Download className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium truncate">{template.name}</span>
        <span className="text-xs text-muted-foreground shrink-0">v{template.version}</span>
      </div>
      {template.description && (
        <p className="text-xs text-muted-foreground line-clamp-2">{template.description}</p>
      )}
      {variant === 'full' && (
        <p className="text-xs text-muted-foreground/70">{template.skillsetName}</p>
      )}
    </button>
  )
}
