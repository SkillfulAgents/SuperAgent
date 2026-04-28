import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
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
      <DialogContent className="sm:max-w-2xl" data-testid="system-prompt-dialog">
        <DialogHeader>
          <DialogTitle>System Prompt</DialogTitle>
          <DialogDescription>
            Custom instructions that will be appended to the default Claude Code system prompt.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Enter custom instructions for this agent..."
            className="min-h-[300px] font-mono text-sm"
            disabled={locked}
          />
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
