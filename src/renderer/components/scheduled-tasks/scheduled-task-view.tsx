/**
 * Scheduled Task View
 *
 * Displays details of a pending scheduled task, including the prompt
 * that will be executed and options to cancel the task.
 */

import { Clock, Calendar, Repeat, Trash2, MessageSquare } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  useScheduledTask,
  useCancelScheduledTask,
  useScheduledTaskSessions,
} from '@renderer/hooks/use-scheduled-tasks'
import { useSelection } from '@renderer/context/selection-context'
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

interface ScheduledTaskViewProps {
  taskId: string
  agentSlug: string
}

export function ScheduledTaskView({ taskId, agentSlug }: ScheduledTaskViewProps) {
  const { data: task, isLoading, error } = useScheduledTask(taskId)
  const { data: sessions = [] } = useScheduledTaskSessions(taskId)
  const cancelTask = useCancelScheduledTask()
  const { handleScheduledTaskDeleted, selectSession } = useSelection()

  const handleCancel = async () => {
    try {
      await cancelTask.mutateAsync({ taskId, agentSlug })
      handleScheduledTaskDeleted(taskId)
    } catch (err) {
      console.error('Failed to cancel scheduled task:', err)
    }
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Loading scheduled task...
      </div>
    )
  }

  if (error || !task) {
    return (
      <div className="flex-1 flex items-center justify-center text-destructive">
        Failed to load scheduled task
      </div>
    )
  }

  const nextExecution = new Date(task.nextExecutionAt)
  const isRecurring = task.isRecurring

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Task header */}
      <div className="p-6 border-b">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold mb-2">
              {task.name || 'Scheduled Task'}
            </h2>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-1">
                {isRecurring ? (
                  <Repeat className="h-4 w-4" />
                ) : (
                  <Clock className="h-4 w-4" />
                )}
                <span>{isRecurring ? 'Recurring' : 'One-time'}</span>
              </div>
              <div className="flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                <span>{task.scheduleExpression}</span>
              </div>
            </div>
          </div>

          {task.status === 'pending' && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Trash2 className="h-4 w-4 mr-2" />
                  Cancel Task
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Cancel Scheduled Task</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to cancel this scheduled task? This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep Task</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleCancel}
                    disabled={cancelTask.isPending}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {cancelTask.isPending ? 'Cancelling...' : 'Cancel Task'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {/* Task details */}
      <div className="flex-1 overflow-auto p-6">
        {/* Next execution time */}
        <div className="mb-6">
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            {task.status === 'pending' ? 'Next Execution' : 'Status'}
          </h3>
          {task.status === 'pending' ? (
            <div className="text-lg">
              {nextExecution.toLocaleString()}
            </div>
          ) : (
            <div className="text-lg capitalize">{task.status}</div>
          )}
        </div>

        {/* Execution count for recurring tasks */}
        {isRecurring && task.executionCount > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Execution Count
            </h3>
            <div className="text-lg">{task.executionCount}</div>
          </div>
        )}

        {/* Prompt */}
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            Task Prompt
          </h3>
          <div className="border-2 border-dashed border-muted rounded-lg p-4 bg-muted/20">
            <div className="flex items-start gap-2 mb-3 text-sm text-muted-foreground">
              <Clock className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                This prompt will be sent to the agent{' '}
                {task.status === 'pending'
                  ? `on ${nextExecution.toLocaleString()}`
                  : 'when executed'}
              </span>
            </div>
            <div className="whitespace-pre-wrap text-sm">{task.prompt}</div>
          </div>
        </div>

        {/* Related Sessions */}
        {sessions.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Related Sessions ({sessions.length})
            </h3>
            <div className="space-y-2">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  onClick={() => selectSession(session.id)}
                  className="w-full flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors text-left"
                >
                  <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{session.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(session.createdAt).toLocaleString()}
                      {session.messageCount > 0 && (
                        <span className="ml-2">• {session.messageCount} messages</span>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Last execution info */}
        {task.lastExecutedAt && sessions.length === 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Last Executed
            </h3>
            <div className="text-sm">
              {new Date(task.lastExecutedAt).toLocaleString()}
              {task.lastSessionId && (
                <span className="text-muted-foreground ml-2">
                  (Session: {task.lastSessionId.slice(0, 8)}...)
                </span>
              )}
            </div>
          </div>
        )}

        {/* Created info */}
        <div className="mt-6">
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            Created
          </h3>
          <div className="text-sm">
            {new Date(task.createdAt).toLocaleString()}
          </div>
        </div>
      </div>
    </div>
  )
}
