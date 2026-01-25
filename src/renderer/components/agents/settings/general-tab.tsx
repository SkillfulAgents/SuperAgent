
import { useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@renderer/components/ui/alert-dialog'
import { useDeleteAgent } from '@renderer/hooks/use-agents'
import { useSelection } from '@renderer/context/selection-context'
import { Trash2 } from 'lucide-react'

interface GeneralTabProps {
  name: string
  agentSlug: string
  onNameChange: (name: string) => void
  onDialogClose: () => void
}

export function GeneralTab({ name, agentSlug, onNameChange, onDialogClose }: GeneralTabProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  const deleteAgent = useDeleteAgent()
  const { handleAgentDeleted } = useSelection()

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await deleteAgent.mutateAsync(agentSlug)
      onDialogClose()
      handleAgentDeleted(agentSlug)
    } catch (error) {
      console.error('Failed to delete agent:', error)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="agent-name">Agent Name</Label>
        <Input
          id="agent-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Enter agent name"
        />
      </div>

      {/* Danger Zone */}
      <div className="pt-4 border-t">
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-destructive">Danger Zone</h3>
          <p className="text-sm text-muted-foreground">
            Permanently delete this agent and all its sessions, messages, and data.
          </p>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm">
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Agent
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Agent</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete &quot;{name}&quot;? This will permanently delete
                  the agent and all its sessions, messages, and data. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {isDeleting ? 'Deleting...' : 'Delete'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  )
}
