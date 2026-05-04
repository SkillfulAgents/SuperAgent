import { useMemo, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Switch } from '@renderer/components/ui/switch'
import {
  MoreVertical,
  Play,
  Info,
  Trash2,
  Pause,
} from 'lucide-react'
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
import {
  useWebhookTriggers,
  useCancelWebhookTrigger,
  usePauseWebhookTrigger,
  useResumeWebhookTrigger,
  type WebhookTrigger,
} from '@renderer/hooks/use-webhook-triggers'
import { useHumanizedCron } from '@renderer/hooks/use-humanized-cron'
import { formatRelativeTime } from '@renderer/components/home/home-page'
import { HomeCollapsible } from './home-collapsible'
import type { ApiScheduledTask } from '@shared/lib/types/api'

interface HomeTriggersProps {
  agentSlug: string
  scheduledTasks: ApiScheduledTask[]
  onSelectTask: (taskId: string) => void
  onSelectWebhook: (webhookId: string) => void
}

type TriggerItem =
  | { kind: 'cron'; createdAtMs: number; task: ApiScheduledTask }
  | { kind: 'webhook'; createdAtMs: number; trigger: WebhookTrigger }

export function HomeTriggers({
  agentSlug,
  scheduledTasks,
  onSelectTask,
  onSelectWebhook,
}: HomeTriggersProps) {
  const { data: webhookTriggersData } = useWebhookTriggers(agentSlug)

  const items = useMemo<TriggerItem[]>(() => {
    const cronItems: TriggerItem[] = scheduledTasks.map((task) => ({
      kind: 'cron',
      createdAtMs: new Date(task.createdAt).getTime(),
      task,
    }))
    const webhookItems: TriggerItem[] = (webhookTriggersData ?? [])
      .filter((t) => t.status !== 'cancelled')
      .map((trigger) => ({
        kind: 'webhook',
        createdAtMs: new Date(trigger.createdAt).getTime(),
        trigger,
      }))
    return [...cronItems, ...webhookItems].sort((a, b) => b.createdAtMs - a.createdAtMs)
  }, [scheduledTasks, webhookTriggersData])

  return (
    <HomeCollapsible title="Triggers">
      {items.length > 0 ? (
        <div className="mt-2 divide-y divide-border/50">
          {items.map((item) =>
            item.kind === 'cron' ? (
              <CronRow
                key={`c-${item.task.id}`}
                task={item.task}
                agentSlug={agentSlug}
                onSelect={() => onSelectTask(item.task.id)}
              />
            ) : (
              <WebhookRow
                key={`w-${item.trigger.id}`}
                trigger={item.trigger}
                agentSlug={agentSlug}
                onSelect={() => onSelectWebhook(item.trigger.id)}
              />
            ),
          )}
        </div>
      ) : (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">No triggers yet</p>
          <p className="text-xs mt-1">
            Triggers fire your agent — on a schedule (crons) or in response to events (webhooks).
            Your agent will create them as needed.
          </p>
        </div>
      )}
    </HomeCollapsible>
  )
}

function CronRow({
  task,
  agentSlug,
  onSelect,
}: {
  task: ApiScheduledTask
  agentSlug: string
  onSelect: () => void
}) {
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
            <span className="inline-flex items-center gap-0.5 text-2xs px-1.5 py-0 rounded-full bg-muted text-muted-foreground">
              <Pause className="h-2.5 w-2.5 fill-current" />
              Paused
            </span>
          )}
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground mt-0.5">
          <span>cron · {humanizedCron ?? 'One-time'}</span>
          {task.nextExecutionAt && !isPaused && (
            <span>{formatRelativeTime(task.nextExecutionAt)}</span>
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
              {canPause && (
                <>
                  <div className="flex w-full items-center justify-between px-2 py-1.5">
                    <div
                      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium ${
                        isPaused
                          ? 'bg-muted text-muted-foreground'
                          : 'bg-green-500/10 text-green-700 dark:text-green-400'
                      }`}
                    >
                      {isPaused ? (
                        <Pause className="h-2.5 w-2.5 fill-current" />
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                      )}
                      {isPaused ? 'Paused' : 'Active'}
                    </div>
                    <Switch
                      className="scale-75 origin-right"
                      checked={!isPaused}
                      disabled={pauseTask.isPending || resumeTask.isPending}
                      onClick={(e) => e.stopPropagation()}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          resumeTask.mutate({ taskId: task.id, agentSlug })
                        } else {
                          pauseTask.mutate({ taskId: task.id, agentSlug })
                        }
                      }}
                      aria-label={isPaused ? 'Resume cron' : 'Pause cron'}
                    />
                  </div>
                  <div className="my-1 h-px bg-border" />
                </>
              )}
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect()
                }}
              >
                <Info className="h-3.5 w-3.5" />
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
                <Play className="h-3.5 w-3.5 fill-current" />
                {runNow.isPending ? 'Running...' : 'Run Now'}
              </button>
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
              Are you sure you want to delete &quot;{task.name ?? 'this cron'}&quot;? This action
              cannot be undone.
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

function WebhookRow({
  trigger,
  agentSlug,
  onSelect,
}: {
  trigger: WebhookTrigger
  agentSlug: string
  onSelect: () => void
}) {
  const cancelTrigger = useCancelWebhookTrigger()
  const pauseTrigger = usePauseWebhookTrigger()
  const resumeTrigger = useResumeWebhookTrigger()
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const isPaused = trigger.status === 'paused'
  const displayName = trigger.name ?? trigger.triggerType

  return (
    <>
      <button
        onClick={onSelect}
        className="group relative w-full py-3 px-4 text-left hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-1.5">
          <div className="text-xs font-medium truncate">{displayName}</div>
          {isPaused && (
            <span className="inline-flex items-center gap-0.5 text-2xs px-1.5 py-0 rounded-full bg-muted text-muted-foreground">
              <Pause className="h-2.5 w-2.5 fill-current" />
              Paused
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground mt-0.5">
          <span className="truncate lowercase">webhook · {trigger.triggerType}</span>
          <span className="shrink-0">
            {trigger.lastFiredAt ? formatRelativeTime(trigger.lastFiredAt) : 'Never fired'}
          </span>
        </div>
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-6 w-6"
                aria-label="Webhook trigger actions"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-36 p-1">
              <div className="flex w-full items-center justify-between px-2 py-1.5">
                <div
                  className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium ${
                    isPaused
                      ? 'bg-muted text-muted-foreground'
                      : 'bg-green-500/10 text-green-700 dark:text-green-400'
                  }`}
                >
                  {isPaused ? (
                    <Pause className="h-2.5 w-2.5 fill-current" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  )}
                  {isPaused ? 'Paused' : 'Active'}
                </div>
                <Switch
                  className="scale-75 origin-right"
                  checked={!isPaused}
                  disabled={pauseTrigger.isPending || resumeTrigger.isPending}
                  onClick={(e) => e.stopPropagation()}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      resumeTrigger.mutate({ triggerId: trigger.id, agentSlug })
                    } else {
                      pauseTrigger.mutate({ triggerId: trigger.id, agentSlug })
                    }
                  }}
                  aria-label={isPaused ? 'Resume webhook' : 'Pause webhook'}
                />
              </div>
              <div className="my-1 h-px bg-border" />
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect()
                }}
              >
                <Info className="h-3.5 w-3.5" />
                View Details
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowDeleteDialog(true)
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete Webhook
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </button>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Webhook</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{displayName}&quot;? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Webhook</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => cancelTrigger.mutate({ id: trigger.id, agentSlug })}
              disabled={cancelTrigger.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelTrigger.isPending ? 'Deleting...' : 'Delete Webhook'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
