import type { ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ChevronRight, PanelRightOpen } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { useFilePreview } from '@renderer/context/file-preview-context'

interface HomeExtrasProps {
  agentSlug: string
  onOpenSettings?: (tab?: string) => void
  className?: string
}

export function HomeExtras({ agentSlug, onOpenSettings, className }: HomeExtrasProps) {
  const navigate = useNavigate()
  const { openFolder } = useFilePreview()

  return (
    <div className={cn("rounded-xl border bg-background py-2", className)}>
      <div className="divide-y divide-border/50">
        <ExtrasButton label="System Prompt" onClick={() => onOpenSettings?.('system-prompt')} />
        <ExtrasButton
          label="Agent Directory"
          onClick={() => openFolder('/workspace', agentSlug)}
          hoverIcon={<PanelRightOpen className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
          testId="home-agent-directory-open-browser"
        />
        <ExtrasButton label="Secrets" onClick={() => onOpenSettings?.('secrets')} />
        <ExtrasButton
          label="API Logs"
          onClick={() => {
            void navigate({ to: '/agents/$slug/api-logs', params: { slug: agentSlug } })
          }}
          testId="home-api-logs-open-page"
        />
      </div>
    </div>
  )
}

function ExtrasButton({ label, onClick, hoverIcon, testId }: { label: string; onClick: () => void; hoverIcon?: ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
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
