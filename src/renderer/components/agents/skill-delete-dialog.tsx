import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { useDeleteSkill } from '@renderer/hooks/use-agent-skills'

interface SkillDeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentSlug: string
  skillDir: string
  skillName?: string | null
}

export function SkillDeleteDialog({
  open,
  onOpenChange,
  agentSlug,
  skillDir,
  skillName,
}: SkillDeleteDialogProps) {
  const deleteSkill = useDeleteSkill()
  const displayName = skillName || skillDir

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!deleteSkill.isPending) onOpenChange(nextOpen)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Skill</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove {displayName} from this agent. You can add it again
            from your team skills if it is still available.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteSkill.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={deleteSkill.isPending}
            onClick={(event) => {
              event.preventDefault()
              deleteSkill.mutate(
                { agentSlug, skillDir },
                {
                  onSuccess: () => {
                    onOpenChange(false)
                    toast.success(`Deleted skill "${displayName}"`)
                  },
                  onError: (err) => toast.error('Delete failed', { description: err.message }),
                },
              )
            }}
          >
            {deleteSkill.isPending ? 'Deleting...' : 'Delete Skill'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
