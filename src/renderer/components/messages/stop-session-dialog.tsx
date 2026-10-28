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
import type { LabeledBackgroundTask } from '@renderer/lib/background-task-label'

interface StopSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The background work that would survive a plain stop. */
  tasks: LabeledBackgroundTask[]
  /**
   * A response is being generated. When false the agent is only waiting on
   * its background tasks, so there is no turn to stop by itself.
   */
  turnInProgress: boolean
  /** Stop the response, leave the tasks running. */
  onStopTurn: () => void
  /** Stop the response and every task. */
  onStopAll: () => void
}

/**
 * Asked when Stop is pressed while background tasks are running. Stopping a
 * turn used to kill them silently; now the user chooses, and sees what they
 * are choosing about.
 */
export function StopSessionDialog({ open, onOpenChange, tasks, turnInProgress, onStopTurn, onStopAll }: StopSessionDialogProps) {
  const count = tasks.length
  const noun = count === 1 ? 'background task' : 'background tasks'

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="stop-session-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {turnInProgress ? `Stop the ${noun} too?` : `Stop ${count === 1 ? 'the' : count} ${noun}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {turnInProgress
              ? `The agent is running ${count} ${noun} alongside this response. They can keep running after the response is stopped.`
              : `The agent is waiting on ${count} ${noun}. Stopping ends ${count === 1 ? 'it' : 'them'} now.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 space-y-1 overflow-y-auto text-sm" data-testid="stop-session-dialog-tasks">
          {tasks.map((task) => (
            <li key={task.taskId} className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 font-medium">{task.title}</span>
              {task.detail && (
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={task.detail}>
                  {task.detail}
                </span>
              )}
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="stop-session-cancel">Cancel</AlertDialogCancel>
          {turnInProgress && (
            <AlertDialogAction data-testid="stop-session-keep-tasks" onClick={onStopTurn}>
              Stop response, keep tasks
            </AlertDialogAction>
          )}
          <AlertDialogAction
            data-testid="stop-session-everything"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onStopAll}
          >
            {turnInProgress ? 'Stop everything' : `Stop ${count === 1 ? 'task' : 'tasks'}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
