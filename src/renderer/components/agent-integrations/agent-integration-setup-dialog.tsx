import { Clock3 } from 'lucide-react'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { useSetChannelDeferred } from '@renderer/hooks/use-finished-setup'
import type { IntegrationSetupProps, IntegrationSetupProvider } from './setup-types'

interface AgentIntegrationSetupDialogProps extends Pick<IntegrationSetupProps, 'initial' | 'onIntegrationCreated'> {
  agentSlug: string
  /** Non-null opens the dialog for that provider; null is closed. */
  provider: IntegrationSetupProvider | null
  allowDefer?: boolean
  onOpenChange: (open: boolean) => void
}

/** Shared shell; each provider owns its credential form. */
export function AgentIntegrationSetupDialog({ agentSlug, provider, onOpenChange, initial, onIntegrationCreated, allowDefer }: AgentIntegrationSetupDialogProps) {
  return (
    <Dialog open={!!provider} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] max-w-3xl flex-col overflow-y-auto">
        {provider && <provider.Setup key={provider.slug} agentSlug={agentSlug} onClose={() => onOpenChange(false)} initial={initial} onIntegrationCreated={onIntegrationCreated} />}
        {allowDefer && provider && <DeferChannelButton agentSlug={agentSlug} provider={provider.slug} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

export function DeferChannelButton({ agentSlug, provider, onClose }: {
  agentSlug: string; provider: IntegrationSetupProvider['slug']; onClose: () => void
}) {
  const save = useSetChannelDeferred(agentSlug)
  return <div className="flex shrink-0 justify-end border-t pt-3">
    <Button type="button" size="sm" variant="outline" disabled={save.isPending}
      onClick={() => save.mutate({ provider, deferred: true }, { onSuccess: onClose })}>
      <Clock3 aria-hidden /> Set this up later
    </Button>
  </div>
}
