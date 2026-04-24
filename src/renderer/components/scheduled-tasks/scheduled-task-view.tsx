/**
 * Scheduled Task View
 *
 * Displays details of a pending scheduled task, including the prompt
 * that will be executed and options to cancel, run now, or edit schedule.
 */

import { useState } from 'react'
import { Trash2, Play, Pencil, Loader2, Settings, Pause, ArrowUpDown } from 'lucide-react'
import { RelatedSessions, type SortOrder } from '@renderer/components/sessions/related-sessions'
import { useHumanizedCron } from '@renderer/hooks/use-humanized-cron'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
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
  usePauseScheduledTask,
  useResumeScheduledTask,
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
} from '@renderer/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'

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
  const pauseTask = usePauseScheduledTask()
  const resumeTask = useResumeScheduledTask()
  const { handleScheduledTaskDeleted, selectSession } = useSelection()
  const { canUseAgent } = useUser()
  const canCancel = canUseAgent(agentSlug)
  const humanizedCron = useHumanizedCron(task?.isRecurring ? task.scheduleExpression : null)
  const isActive = task?.status === 'pending' || task?.status === 'paused'
  const isPaused = task?.status === 'paused'

  // Settings popover / delete dialog state
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  // Run history sort
  const [runSort, setRunSort] = useState<SortOrder>('newest')
  const [runSortPopoverOpen, setRunSortPopoverOpen] = useState(false)

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

  const formatDateOnlyInTaskTz = (date: Date | string) => {
    const d = typeof date === 'string' ? new Date(date) : date
    const tz = task?.timezone || undefined
    return d.toLocaleDateString(undefined, { timeZone: tz })
  }

  const formatTimeOnlyInTaskTz = (date: Date | string) => {
    const d = typeof date === 'string' ? new Date(date) : date
    const tz = task?.timezone || undefined
    return d.toLocaleTimeString(undefined, { timeZone: tz })
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
    <div className="flex-1 flex flex-col overflow-y-auto max-w-4xl w-full mx-auto px-10">
      {/* Task header */}
      <div className="pt-6 pb-10">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-xl font-medium truncate">
            {task.name || 'Scheduled Task'}
          </h2>

          {isActive && canCancel && (
            <div className="flex items-center gap-2 shrink-0">
              {/* Settings popover */}
              <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Cron settings"
                    className="text-muted-foreground"
                  >
                    <Settings className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-44 p-1">
                  {isRecurring && !isPaused && (
                    <button
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted transition-colors"
                      onClick={() => {
                        setSettingsOpen(false)
                        handleOpenEditSchedule()
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                      Edit Schedule
                    </button>
                  )}
                  <button
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
                    onClick={() => {
                      setSettingsOpen(false)
                      setDeleteDialogOpen(true)
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete Cron
                  </button>
                </PopoverContent>
              </Popover>

              {/* Run Now button (far right) */}
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

              {/* Delete confirmation dialog */}
              <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete Cron</AlertDialogTitle>
                    <AlertDialogDescription>
                      Are you sure you want to delete this cron? This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep Cron</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleCancel}
                      disabled={cancelTask.isPending}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {cancelTask.isPending ? 'Deleting...' : 'Delete Cron'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </div>
      </div>

      {/* Two-column body */}
      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-y-6 lg:gap-x-10 lg:gap-y-0">
        {/* Run History (left, 2/3) */}
        <div className="pb-6 order-2 lg:order-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-muted-foreground flex-1">Run History</h2>
            {sessions.length > 0 && (
              <Popover open={runSortPopoverOpen} onOpenChange={setRunSortPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button type="button" size="icon" variant="ghost" className="h-6 w-6 shrink-0" aria-label="Sort runs">
                    <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-40 p-1">
                  <button
                    className={`flex w-full items-center rounded-sm px-2 py-1.5 text-xs transition-colors ${runSort === 'newest' ? 'bg-muted font-medium' : 'hover:bg-muted'}`}
                    onClick={() => { setRunSort('newest'); setRunSortPopoverOpen(false) }}
                  >
                    Newest first
                  </button>
                  <button
                    className={`flex w-full items-center rounded-sm px-2 py-1.5 text-xs transition-colors ${runSort === 'oldest' ? 'bg-muted font-medium' : 'hover:bg-muted'}`}
                    onClick={() => { setRunSort('oldest'); setRunSortPopoverOpen(false) }}
                  >
                    Oldest first
                  </button>
                </PopoverContent>
              </Popover>
            )}
          </div>
          <div className="border-b mt-2" />
          {sessions.length > 0 ? (
            <RelatedSessions
              sessions={sessions}
              formatDate={formatDateOnlyInTaskTz}
              formatSubtext={formatTimeOnlyInTaskTz}
              agentSlug={agentSlug}
              showIcon={false}
              showHeader={false}
              sortOrder={runSort}
              dateAsTitle
              pageSize={15}
            />
          ) : (
            <div className="rounded-lg border border-dashed p-4 mt-3 text-sm text-muted-foreground">
              No runs yet. Sessions will appear here once this cron runs.
            </div>
          )}
        </div>

        {/* Details card (right, 1/3) */}
        <div className="space-y-3 order-1 lg:order-2">
          {/* Instructions card */}
          <div className="rounded-xl border bg-background py-4">
            <div className="px-4">
              <span className="text-sm font-medium text-muted-foreground">Task Prompt</span>
            </div>
            <div className="px-4 pt-3 whitespace-pre-wrap text-xs">{task.prompt}</div>
          </div>

          {/* Details + toggle card */}
          <div className="rounded-xl border bg-background py-4">
            <div className="px-4 flex items-center justify-between gap-4">
              <span className="text-sm font-medium text-muted-foreground">Details</span>
              {isRecurring && isActive && canCancel ? (
                <div className="flex items-center gap-2">
                  <div className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium ${isPaused ? 'bg-muted text-muted-foreground' : 'bg-green-500/10 text-green-700 dark:text-green-400'}`}>
                    {isPaused ? (
                      <Pause className="h-2.5 w-2.5 fill-current" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                    )}
                    {isPaused ? 'Paused' : 'Active'}
                  </div>
                  <Switch
                    checked={!isPaused}
                    disabled={pauseTask.isPending || resumeTask.isPending}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        resumeTask.mutate({ taskId, agentSlug })
                      } else {
                        pauseTask.mutate({ taskId, agentSlug })
                      }
                    }}
                    aria-label={isPaused ? 'Resume cron' : 'Pause cron'}
                  />
                </div>
              ) : (
                <span className="text-xs text-muted-foreground capitalize">{task.status}</span>
              )}
            </div>

            <dl className="px-4 pt-3 space-y-4">
              <div>
                <dt className="text-xs text-muted-foreground">Schedule</dt>
                <dd className="text-xs font-normal">
                  {humanizedCron
                    ? `Runs ${humanizedCron.charAt(0).toLowerCase() + humanizedCron.slice(1)}`
                    : task.scheduleExpression}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Timezone</dt>
                <dd className="text-xs font-normal">{taskTzLabel}</dd>
              </div>
              {(isRecurring && task.executionCount > 0) || task.status === 'pending' ? (
                <div className="flex gap-8">
                  {task.status === 'pending' && (
                    <div>
                      <dt className="text-xs text-muted-foreground">Next Run</dt>
                      <dd className="text-xs font-normal">{formatInTaskTz(nextExecution)}</dd>
                    </div>
                  )}
                  {isRecurring && task.executionCount > 0 && (
                    <div>
                      <dt className="text-xs text-muted-foreground">Runs</dt>
                      <dd className="text-xs font-normal">{task.executionCount}</dd>
                    </div>
                  )}
                </div>
              ) : null}
            </dl>

            <div className="px-4 pt-6 text-xs text-muted-foreground">
              Created {formatInTaskTz(task.createdAt)}
            </div>
          </div>

          {/* Last execution info */}
          {task.lastExecutedAt && sessions.length === 0 && (
            <div>
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

        </div>
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

            {isActive && canCancel && (
              <div className="space-y-2 pt-2 border-t">
                <Label htmlFor="timezone-picker">Timezone</Label>
                <TimezonePicker
                  value={task.timezone || 'UTC'}
                  onValueChange={(value) => {
                    updateTimezone.mutate({ taskId: task.id, timezone: value })
                  }}
                  disabled={updateTimezone.isPending}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  Schedule times are interpreted in this timezone
                </p>
              </div>
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
