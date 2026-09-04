import type { ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ChevronRight, PanelRightOpen } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { HomeDefaultModel } from './home-default-model'
import { HomeRetention } from './home-retention'

interface HomeExtrasProps {
  agentSlug: string
  onOpenSettings?: (tab?: string) => void
  className?: string
}

export function HomeExtras({ agentSlug, onOpenSettings, className }: HomeExtrasProps) {
  const navigate = useNavigate()
  const { openFolder } = useFilePreview()

  return (
    // Two sections. The per-agent preferences (pickers) are a labelled section
    // group, the same shape as a group in the settings nav, with their original
    // row padding; the navigation rows below are one uniform height and sit
    // flush with the card, which clips them to its rounded corners so the
    // hover fill stays inside.
    <div className={cn("overflow-hidden rounded-xl border bg-background", className)}>
      <div className="pb-2" data-testid="home-preferences-group">
        <p className="px-4 pt-4 pb-1 text-xs font-medium text-muted-foreground">Preferences</p>
        <div className="divide-y divide-border/50">
          <HomeDefaultModel agentSlug={agentSlug} />
          <HomeRetention agentSlug={agentSlug} />
        </div>
      </div>
      <div className="divide-y divide-border/50 border-t border-border/50">
        <ExtrasButton
          label="Agent-to-agent connections"
          onClick={() => {
            void navigate({ to: '/agents/$slug/x-agent-permissions', params: { slug: agentSlug } })
          }}
          testId="home-x-agent-permissions-open-page"
        />
        <ExtrasButton label="System Prompt" onClick={() => onOpenSettings?.('system-prompt')} />
        <ExtrasButton
          label="Agent Directory"
          onClick={() => openFolder('/workspace', agentSlug)}
          hoverIcon={<PanelRightOpen className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
          testId="home-agent-directory-open-browser"
        />
        <ExtrasButton
          label="Secrets"
          onClick={() => {
            void navigate({ to: '/agents/$slug/secrets', params: { slug: agentSlug } })
          }}
          testId="home-secrets-open-page"
        />
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
      // min-h-12: every navigation row is the same height, including the last
      // one, which sits flush with the card's bottom edge. The focus ring is
      // inset because the card clips its rows to the rounded corners.
      className="group flex min-h-12 w-full items-center justify-between px-4 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
