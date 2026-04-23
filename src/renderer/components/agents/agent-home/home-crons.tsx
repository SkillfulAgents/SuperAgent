import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { MoreVertical, Play, ExternalLink, Trash2, Pause, PlayCircle } from 'lucide-react'
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
  useRunScheduledTaskNow,
  useCancelScheduledTask,
  usePauseScheduledTask,
  useResumeScheduledTask,
} from '@renderer/hooks/use-scheduled-tasks'
import { useHumanizedCron } from '@renderer/hooks/use-humanized-cron'
import { HomeCollapsible } from './home-collapsible'
import type { ApiScheduledTask } from '@shared/lib/types/api'

interface HomeCronsProps {
  agentSlug: string
  scheduledTasks: ApiScheduledTask[]
  formatDate: (dateStr: string) => string
  onSelectTask: (taskId: string) => void
}

export function HomeCrons({ agentSlug, scheduledTasks, formatDate, onSelectTask }: HomeCronsProps) {
  return (
    <HomeCollapsible title="Crons">
      {scheduledTasks.length > 0 ? (
        <div className="mt-2 divide-y divide-border/50">
          {scheduledTasks.map((task) => (
            <CronRow key={task.id} task={task} agentSlug={agentSlug} formatDate={formatDate} onSelect={() => onSelectTask(task.id)} />
          ))}
        </div>
      ) : (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">No crons yet</p>
          <p className="text-xs mt-1">Crons trigger your agent to do work for you on a schedule. Your agent will create crons for you as needed.</p>
        </div>
      )}
    </HomeCollapsible>
  )
}

function CronRow({ task, agentSlug, formatDate, onSelect }: { task: ApiScheduledTask; agentSlug: string; formatDate: (dateStr: string) => string; onSelect: () => void }) {
  const runNow = useRunScheduledTaskNow()
  const cancelTask = useCancelScheduledTask()
  const pauseTask = usePauseScheduledTask()
  const resumeTask = useResumeScheduledTask()
  const humanizedCron = useHumanizedCron(task.isRecurring ? task.scheduleExpression : null)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const isPaused = task.status === 'paused'
  const canPause = task.isRecurring

  return (
    <>
      <button
        onClick={onSelect}
        className="group relative w-full py-3 px-4 text-left hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-1.5">
          <div className="text-xs font-medium truncate">{task.name ?? 'Scheduled Task'}</div>
          {isPaused && (
            <span className="inline-flex items-center gap-0.5 rounded-sm bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Pause className="h-2.5 w-2.5" />
              Paused
            </span>
          )}
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground mt-0.5">
          <span>{humanizedCron ?? 'One-time'}</span>
          {task.nextExecutionAt && !isPaused && (
            <span>Next: {formatDate(new Date(task.nextExecutionAt).toISOString())}</span>
          )}
        </div>
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-6 w-6"
                aria-label="Scheduled task actions"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-36 p-1">
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect()
                }}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View Details
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                disabled={runNow.isPending}
                onClick={(e) => {
                  e.stopPropagation()
                  runNow.mutate({ taskId: task.id, agentSlug })
                }}
              >
                <Play className="h-3.5 w-3.5" />
                {runNow.isPending ? 'Running...' : 'Run Now'}
              </button>
              {canPause && !isPaused && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  disabled={pauseTask.isPending}
                  onClick={(e) => {
                    e.stopPropagation()
                    pauseTask.mutate({ taskId: task.id, agentSlug })
                  }}
                >
                  <Pause className="h-3.5 w-3.5" />
                  {pauseTask.isPending ? 'Pausing...' : 'Pause'}
                </button>
              )}
              {canPause && isPaused && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  disabled={resumeTask.isPending}
                  onClick={(e) => {
                    e.stopPropagation()
                    resumeTask.mutate({ taskId: task.id, agentSlug })
                  }}
                >
                  <PlayCircle className="h-3.5 w-3.5" />
                  {resumeTask.isPending ? 'Resuming...' : 'Resume'}
                </button>
              )}
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowDeleteDialog(true)
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete Cron
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </button>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Cron</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{task.name ?? 'this cron'}&quot;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Cron</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => cancelTask.mutate({ id: task.id, agentSlug })}
              disabled={cancelTask.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelTask.isPending ? 'Deleting...' : 'Delete Cron'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
