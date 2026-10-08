import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { cn } from '@shared/lib/utils'
import { Button } from '@renderer/components/ui/button'
import { MarkdownComposerEditor } from '@renderer/components/messages/markdown-composer-editor'
import { useUser } from '@renderer/context/user-context'
import { useUpdateAgent, type ApiAgent } from '@renderer/hooks/use-agents'

interface SystemPromptDialogProps {
  agent: ApiAgent
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SystemPromptDialog({ agent, open, onOpenChange }: SystemPromptDialogProps) {
  const [instructions, setInstructions] = React.useState(agent.instructions || '')
  const updateAgent = useUpdateAgent()
  const { isAuthMode, canAdminAgent, rolesReady } = useUser()
  const isOwner = canAdminAgent(agent.slug)
  const locked = isAuthMode && rolesReady && !isOwner

  React.useEffect(() => {
    if (open) {
      setInstructions(agent.instructions || '')
    }
  }, [open, agent.instructions])

  const hasChanges = instructions !== (agent.instructions || '')

  const handleSave = async () => {
    await updateAgent.mutateAsync({
      slug: agent.slug,
      instructions: instructions.trim() || undefined,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" onOpenAutoFocus={(e) => e.preventDefault()} data-testid="system-prompt-dialog">
        <DialogHeader>
          <DialogTitle>System Prompt</DialogTitle>
          <DialogDescription>
            Custom instructions added to the system prompt for this agent.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          {/* The toolbar row carries the top padding, since it sticks to the top while the box scrolls. */}
          <div className={cn('max-h-[60vh] overflow-y-auto rounded-md border border-input px-3 pb-2 shadow-sm focus-within:ring-1 focus-within:ring-ring', locked && 'pt-2')}>
            <MarkdownComposerEditor
              value={instructions}
              onChange={setInstructions}
              placeholder="Enter custom instructions for this agent..."
              minRows={14}
              disabled={locked}
              autoFocus
              dataTestId="system-prompt-editor"
              toolbar={!locked}
              toolbarClassName="sticky top-0 z-10 bg-background pt-2"
            />
          </div>
          {locked && (
            <div
              className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-background/80 backdrop-blur-sm"
              data-testid="system-prompt-no-permission"
            >
              <div className="space-y-2 text-center">
                <p className="text-sm font-medium">You don&apos;t have permission to edit settings</p>
                <p className="text-xs text-muted-foreground">Only agent owners can modify settings.</p>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || updateAgent.isPending || locked}
          >
            {updateAgent.isPending ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
