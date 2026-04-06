/**
 * Scheduled Task View
 *
 * Displays details of a pending scheduled task, including the prompt
 * that will be executed and options to cancel, run now, or edit schedule.
 */

import { useState } from 'react'
import { Clock, Calendar, Repeat, Trash2, Globe, Play, Pencil, Loader2 } from 'lucide-react'
import { RelatedSessions } from '@renderer/components/sessions/related-sessions'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { TimezonePicker } from '@renderer/components/ui/timezone-picker'
import {
  useScheduledTask,
  useCancelScheduledTask,
  useScheduledTaskSessions,
  useUpdateScheduledTaskTimezone,
  useRunScheduledTaskNow,
  useDescribeSchedule,
  useParseSchedule,
  useUpdateSchedule,
} from '@renderer/hooks/use-scheduled-tasks'
import { useSelection } from '@renderer/context/selection-context'
import { useUser } from '@renderer/context/user-context'
import { useRenderTracker } from '@renderer/lib/perf'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'

interface ScheduledTaskViewProps {
  taskId: string
  agentSlug: string
}

export function ScheduledTaskView({ taskId, agentSlug }: ScheduledTaskViewProps) {
  useRenderTracker('ScheduledTaskView')
  const { data: task, isLoading, error } = useScheduledTask(taskId)
  const { data: sessions = [] } = useScheduledTaskSessions(taskId)
  const cancelTask = useCancelScheduledTask()
  const updateTimezone = useUpdateScheduledTaskTimezone()
  const runNow = useRunScheduledTaskNow()
  const { handleScheduledTaskDeleted, selectSession } = useSelection()
  const { canUseAgent } = useUser()
  const canCancel = canUseAgent(agentSlug)

  // Edit schedule modal state
  const [editScheduleOpen, setEditScheduleOpen] = useState(false)
  const [scheduleDescription, setScheduleDescription] = useState('')
  const [parsedExpression, setParsedExpression] = useState<string | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const describeSchedule = useDescribeSchedule()
  const parseSchedule = useParseSchedule()
  const updateSchedule = useUpdateSchedule()

  const formatInTaskTz = (date: Date | string) => {
    const d = typeof date === 'string' ? new Date(date) : date
    const tz = task?.timezone || undefined
    return d.toLocaleString(undefined, { timeZone: tz })
  }

  const taskTzLabel = task?.timezone?.replace(/_/g, ' ') || 'UTC'

  const handleCancel = async () => {
    try {
      await cancelTask.mutateAsync({ id: taskId, agentSlug })
      handleScheduledTaskDeleted(taskId)
    } catch (err) {
      console.error('Failed to cancel scheduled task:', err)
    }
  }

  const handleRunNow = async () => {
    try {
      const result = await runNow.mutateAsync({ taskId, agentSlug })
      selectSession(result.sessionId)
    } catch (err) {
      console.error('Failed to run scheduled task:', err)
    }
  }

  const handleOpenEditSchedule = async () => {
    setEditScheduleOpen(true)
    setParsedExpression(null)
    setParseError(null)
    setScheduleDescription('')

    try {
      const result = await describeSchedule.mutateAsync({ taskId })
      setScheduleDescription(result.description)
    } catch (err) {
      console.error('Failed to describe schedule:', err)
    }
  }

  const handleParseDescription = async () => {
    if (!scheduleDescription.trim()) return
    setParsedExpression(null)
    setParseError(null)

    try {
      const result = await parseSchedule.mutateAsync({
        taskId,
        description: scheduleDescription.trim(),
      })
      setParsedExpression(result.expression)
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Failed to parse schedule')
    }
  }

  const handleSaveSchedule = async () => {
    if (!parsedExpression) return

    try {
      await updateSchedule.mutateAsync({
        taskId,
        scheduleExpression: parsedExpression,
      })
      setEditScheduleOpen(false)
    } catch (err) {
      console.error('Failed to update schedule:', err)
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
              <div className="flex items-center gap-1">
                <Globe className="h-4 w-4" />
                <span>{taskTzLabel}</span>
              </div>
            </div>
          </div>

          {task.status === 'pending' && canCancel && (
            <div className="flex items-center gap-2">
              {/* Run Now button */}
              <Button
                variant="default"
                size="sm"
                onClick={handleRunNow}
                disabled={runNow.isPending}
              >
                {runNow.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                {runNow.isPending ? 'Running...' : 'Run Now'}
              </Button>

              {/* Edit Schedule button (recurring only) */}
              {isRecurring && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleOpenEditSchedule}
                >
                  <Pencil className="h-4 w-4 mr-2" />
                  Edit Schedule
                </Button>
              )}

              {/* Cancel Task button */}
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
            </div>
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
              {formatInTaskTz(nextExecution)}
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
                  ? `on ${formatInTaskTz(nextExecution)}`
                  : 'when executed'}
              </span>
            </div>
            <div className="whitespace-pre-wrap text-sm">{task.prompt}</div>
          </div>
        </div>

        <RelatedSessions sessions={sessions} formatDate={formatInTaskTz} className="mt-6" />

        {/* Last execution info */}
        {task.lastExecutedAt && sessions.length === 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Last Executed
            </h3>
            <div className="text-sm">
              {formatInTaskTz(task.lastExecutedAt)}
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
            {formatInTaskTz(task.createdAt)}
          </div>
        </div>

        {/* Timezone selector */}
        {task.status === 'pending' && canCancel && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              Timezone
            </h3>
            <TimezonePicker
              value={task.timezone || 'UTC'}
              onValueChange={(value) => {
                updateTimezone.mutate({ taskId: task.id, timezone: value })
              }}
              disabled={updateTimezone.isPending}
              className="w-64"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Schedule times are interpreted in this timezone
            </p>
          </div>
        )}
      </div>

      {/* Edit Schedule Modal */}
      <Dialog open={editScheduleOpen} onOpenChange={setEditScheduleOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Schedule</DialogTitle>
            <DialogDescription>
              Modify the schedule description below and convert it to a new cron expression.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="text-xs text-muted-foreground">
              Current expression: <code className="bg-muted px-1 py-0.5 rounded">{task.scheduleExpression}</code>
            </div>

            <div className="space-y-2">
              <Label htmlFor="schedule-description">Schedule Description</Label>
              {describeSchedule.isPending ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Translating schedule...
                </div>
              ) : (
                <Input
                  id="schedule-description"
                  value={scheduleDescription}
                  onChange={(e) => {
                    setScheduleDescription(e.target.value)
                    setParsedExpression(null)
                    setParseError(null)
                  }}
                  placeholder="e.g. Every weekday at 9:00 AM"
                />
              )}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={handleParseDescription}
              disabled={parseSchedule.isPending || !scheduleDescription.trim()}
            >
              {parseSchedule.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Converting...
                </>
              ) : (
                'Convert to Cron'
              )}
            </Button>

            {parsedExpression && (
              <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
                <div className="text-sm font-medium">New cron expression:</div>
                <code className="text-sm bg-muted px-2 py-1 rounded block">{parsedExpression}</code>
              </div>
            )}

            {parseError && (
              <div className="text-sm text-destructive">{parseError}</div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditScheduleOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveSchedule}
              disabled={!parsedExpression || updateSchedule.isPending}
            >
              {updateSchedule.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Schedule'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
