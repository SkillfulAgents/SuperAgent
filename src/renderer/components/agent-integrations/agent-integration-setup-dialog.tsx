import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import type { IntegrationSetupProps, IntegrationSetupProvider } from './setup-types'

interface AgentIntegrationSetupDialogProps extends Pick<IntegrationSetupProps, 'initial' | 'onCreated'> {
  agentSlug: string
  /** Non-null opens the dialog for that provider; null is closed. */
  provider: IntegrationSetupProvider | null
  onOpenChange: (open: boolean) => void
}

/** Shared shell; each provider owns its credential form. */
export function AgentIntegrationSetupDialog({ agentSlug, provider, onOpenChange, initial, onCreated }: AgentIntegrationSetupDialogProps) {
  return (
    <Dialog open={!!provider} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden">
        {provider && <provider.Setup key={provider.slug} agentSlug={agentSlug} onClose={() => onOpenChange(false)} initial={initial} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  )
}
