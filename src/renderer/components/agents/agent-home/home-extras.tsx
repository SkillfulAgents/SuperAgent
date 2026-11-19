import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, PanelRightOpen } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible'
import { HomeDefaultModel } from './home-default-model'
import { HomeRetention } from './home-retention'
import { HOME_SECTION_HEADER_CLASS, useHomeCardLook } from './home-collapsible'

interface HomeExtrasProps {
  agentSlug: string
  onOpenSettings?: (tab?: string) => void
  className?: string
}

export function HomeExtras({ agentSlug, onOpenSettings, className }: HomeExtrasProps) {
  const navigate = useNavigate()
  const { openFolder } = useFilePreview()
  const [open, setOpen] = useState(false)
  const look = useHomeCardLook()

  // Tucked behind a "Show more" toggle ("Show less" once open), closed until opened. Inside
  // are two cards, spaced like any other pair in the column. Neither has
  // vertical padding of its own: that would stack onto its first and last
  // rows and make them read taller than the rest. The three per-agent picker
  // rows are a standalone group at one height; the navigation rows are one
  // uniform height too, flush with their card, which clips them to its
  // rounded corners so the focus ring stays inside.
  const cards = (
    <>
      <div className={cn(look.card, !look.grouped && className)} data-testid="home-preferences-group">
        <div className="divide-y divide-border/50">
          <HomeDefaultModel agentSlug={agentSlug} />
          <HomeRetention agentSlug={agentSlug} />
        </div>
      </div>
      <div className={cn('overflow-hidden', look.card, !look.grouped && className)}>
        <div className="divide-y divide-border/50">
          <ExtrasButton
            label="Agent-to-agent connections"
            onClick={() => {
              void navigate({ to: '/agents/$slug/x-agent-permissions', params: { slug: agentSlug } })
            }}
            testId="home-x-agent-permissions-open-page"
          />
          <ExtrasButton
            label="Memories"
            onClick={() => {
              void navigate({ to: '/agents/$slug/memories', params: { slug: agentSlug } })
            }}
            testId="home-memories-open-page"
          />
          <ExtrasButton label="System Prompt" onClick={() => onOpenSettings?.('system-prompt')} />
          <ExtrasButton
            label="Agent Directory"
            onClick={() => openFolder('/workspace', agentSlug)}
            drawerOpener
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
    </>
  )
  // Team Brain already groups these settings inside its Advanced panel.
  if (!look.grouped) return cards

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('space-y-3', className)}>
      <CollapsibleTrigger asChild>
        <button type="button" className={cn(HOME_SECTION_HEADER_CLASS, 'min-h-8 justify-start gap-1')} data-testid="home-advanced-settings-toggle">
          <span className="text-[12px]/5 text-muted-foreground/70">{open ? 'Show less' : 'Show more'}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground/50 transition-transform [[data-state=closed]>&]:rotate-[-90deg]" aria-hidden="true" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3">{cards}</CollapsibleContent>
    </Collapsible>
  )
}

function ExtrasButton({ label, onClick, drawerOpener, testId }: { label: string; onClick: () => void; drawerOpener?: boolean; testId?: string }) {
  const look = useHomeCardLook()
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      // Lets a page that closes its drawer on outside clicks leave this one open.
      data-drawer-opener={drawerOpener || undefined}
      // min-h-12: every navigation row is the same height, including the last
      // one, which sits flush with the card's bottom edge. The focus ring is
      // inset because the card clips its rows to the rounded corners.
      className={cn('group flex min-h-12 w-full items-center justify-between px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', !look.grouped && 'transition-colors hover:bg-muted/50')}
    >
      <span className={look.label}>{label}</span>
      {drawerOpener && !look.grouped ? (
        <span className="relative h-4 w-4">
          <ChevronRight className="absolute inset-0 h-4 w-4 text-muted-foreground transition-opacity group-hover:opacity-0" aria-hidden="true" />
          <PanelRightOpen className="absolute inset-0 h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
        </span>
      ) : <ChevronRight className={cn('h-4 w-4 text-muted-foreground', look.grouped && 'opacity-50')} aria-hidden="true" />}
    </button>
  )
}
