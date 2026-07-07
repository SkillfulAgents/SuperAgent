import { useMemo, useState, type ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Switch } from '@renderer/components/ui/switch'
import {
  MoreVertical,
  Play,
  Info,
  Trash2,
  Pause,
  ChevronRight,
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
  useScheduledTasks,
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
import { formatDistanceToNow } from 'date-fns'
import { HomeCollapsible } from './home-collapsible'
import type { ApiScheduledTask } from '@shared/lib/types/api'

interface HomeTriggersProps {
  agentSlug: string
  scheduledTasks: ApiScheduledTask[]
  onSelectTask: (taskId: string) => void
  onSelectWebhook: (webhookId: string) => void
  className?: string
}

type TriggerItem =
  | { kind: 'cron'; createdAtMs: number; task: ApiScheduledTask }
  | { kind: 'webhook'; createdAtMs: number; trigger: WebhookTrigger }

export function HomeTriggers({
  agentSlug,
  scheduledTasks,
  onSelectTask,
  onSelectWebhook,
  className,
}: HomeTriggersProps) {
  const { data: webhookTriggersData } = useWebhookTriggers(agentSlug, 'active')
  const { data: cancelledWebhooksData } = useWebhookTriggers(agentSlug, 'cancelled')
  const { data: cancelledTasksData } = useScheduledTasks(agentSlug, 'cancelled')
  const [showDeleted, setShowDeleted] = useState(false)

  const items = useMemo<TriggerItem[]>(() => {
    const cronItems: TriggerItem[] = scheduledTasks.map((task) => ({
      kind: 'cron',
      createdAtMs: new Date(task.createdAt).getTime(),
      task,
    }))
    const webhookItems: TriggerItem[] = (webhookTriggersData ?? []).map((trigger) => ({
      kind: 'webhook',
      createdAtMs: new Date(trigger.createdAt).getTime(),
      trigger,
    }))
    return [...cronItems, ...webhookItems].sort((a, b) => b.createdAtMs - a.createdAtMs)
  }, [scheduledTasks, webhookTriggersData])

  const deletedItems = useMemo<TriggerItem[]>(() => {
    const cronItems: TriggerItem[] = (Array.isArray(cancelledTasksData) ? cancelledTasksData : []).map((task) => ({
      kind: 'cron',
      createdAtMs: new Date(task.createdAt).getTime(),
      task,
    }))
    const webhookItems: TriggerItem[] = (Array.isArray(cancelledWebhooksData) ? cancelledWebhooksData : []).map((trigger) => ({
      kind: 'webhook',
      createdAtMs: new Date(trigger.createdAt).getTime(),
      trigger,
    }))
    return [...cronItems, ...webhookItems].sort((a, b) => b.createdAtMs - a.createdAtMs)
  }, [cancelledTasksData, cancelledWebhooksData])

  const hasDeleted = deletedItems.length > 0

  return (
    <HomeCollapsible title="Triggers" className={className}>
      {items.length > 0 || hasDeleted ? (
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
          {hasDeleted && (
            <>
              <button
                type="button"
                className="flex w-full items-center gap-1 py-2 px-4 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                onClick={() => setShowDeleted((v) => !v)}
              >
                <span>{showDeleted ? 'Hide deleted' : `Show ${deletedItems.length} deleted`}</span>
                <ChevronRight className={`h-3 w-3 transition-transform ${showDeleted ? 'rotate-90' : ''}`} />
              </button>
              {showDeleted && deletedItems.map((item) =>
                item.kind === 'cron' ? (
                  <div key={`c-del-${item.task.id}`} className="opacity-50">
                    <CronRow
                      task={item.task}
                      agentSlug={agentSlug}
                      onSelect={() => onSelectTask(item.task.id)}
                    />
                  </div>
                ) : (
                  <div key={`w-del-${item.trigger.id}`} className="opacity-50">
                    <WebhookRow
                      trigger={item.trigger}
                      agentSlug={agentSlug}
                      onSelect={() => onSelectWebhook(item.trigger.id)}
                    />
                  </div>
                ),
              )}
            </>
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

interface TriggerRowProps {
  name: string
  subtitleLeft: ReactNode
  subtitleRight: ReactNode
  isPaused: boolean
  canTogglePause: boolean
  togglePending: boolean
  onTogglePause: (resume: boolean) => void
  onSelect: () => void
  onConfirmDelete: () => void
  deletePending: boolean
  // 'cron' | 'webhook' — drives copy in popover, dialog, and aria-labels.
  kind: 'cron' | 'webhook'
  // Cron-only Run Now action.
  onRunNow?: () => void
  runNowPending?: boolean
  // When true, the trigger is already deleted — only the View Details action is shown.
  isDeleted?: boolean
}

function TriggerRow({
  name,
  subtitleLeft,
  subtitleRight,
  isPaused,
  canTogglePause,
  togglePending,
  onTogglePause,
  onSelect,
  onConfirmDelete,
  deletePending,
  kind,
  onRunNow,
  runNowPending,
  isDeleted = false,
}: TriggerRowProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const label = kind === 'cron' ? 'Cron' : 'Webhook'

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
        className="group relative w-full py-3 px-4 text-left hover:bg-muted/50 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-1.5">
          <div className="text-xs font-medium truncate">{name}</div>
          {isPaused && (
            <span className="inline-flex items-center gap-0.5 text-2xs px-1.5 py-0 rounded-full bg-muted text-muted-foreground">
              <Pause className="h-2.5 w-2.5 fill-current" />
              Paused
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground mt-0.5">
          {subtitleLeft}
          {subtitleRight}
        </div>
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-6 w-6"
                aria-label={`${label} actions`}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-36 p-1">
              {canTogglePause && !isDeleted && (
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
                      disabled={togglePending}
                      onClick={(e) => e.stopPropagation()}
                      onCheckedChange={onTogglePause}
                      aria-label={isPaused ? `Resume ${kind}` : `Pause ${kind}`}
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
              {onRunNow && !isDeleted && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  disabled={runNowPending}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRunNow()
                  }}
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  {runNowPending ? 'Running...' : 'Run Now'}
                </button>
              )}
              {!isDeleted && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowDeleteDialog(true)
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete {label}
                </button>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {label}</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{name}&quot;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep {label}</AlertDialogCancel>
            <AlertDialogAction
              onClick={onConfirmDelete}
              disabled={deletePending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletePending ? 'Deleting...' : `Delete ${label}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
  const isPaused = task.status === 'paused'
  const isDeleted = task.status === 'cancelled'

  return (
    <TriggerRow
      kind="cron"
      isDeleted={isDeleted}
      name={task.name ?? 'Scheduled Task'}
      subtitleLeft={<span>cron · {humanizedCron ?? 'One-time'}</span>}
      subtitleRight={
        task.nextExecutionAt && !isPaused ? (
          <span className="shrink-0">
            <span className="text-muted-foreground">next run </span>
            {formatDistanceToNow(new Date(task.nextExecutionAt), { addSuffix: true })}
          </span>
        ) : null
      }
      isPaused={isPaused}
      canTogglePause={task.isRecurring}
      togglePending={pauseTask.isPending || resumeTask.isPending}
      onTogglePause={(resume) => {
        if (resume) {
          resumeTask.mutate({ taskId: task.id, agentSlug })
        } else {
          pauseTask.mutate({ taskId: task.id, agentSlug })
        }
      }}
      onSelect={onSelect}
      onConfirmDelete={() => cancelTask.mutate({ id: task.id, agentSlug })}
      deletePending={cancelTask.isPending}
      onRunNow={() => runNow.mutate({ taskId: task.id, agentSlug })}
      runNowPending={runNow.isPending}
    />
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
  const isPaused = trigger.status === 'paused'
  const isDeleted = trigger.status === 'cancelled'
  const displayName = trigger.name ?? trigger.triggerType
  const isCustom = trigger.kind === 'custom'

  return (
    <TriggerRow
      kind="webhook"
      isDeleted={isDeleted}
      name={displayName}
      subtitleLeft={
        <span className="truncate lowercase">
          {isCustom ? 'webhook · custom endpoint' : `webhook · ${trigger.triggerType}`}
        </span>
      }
      subtitleRight={
        <span className="shrink-0">
          {trigger.lastFiredAt ? (
            <>
              <span className="text-muted-foreground">last run </span>
              {formatDistanceToNow(new Date(trigger.lastFiredAt), { addSuffix: true })}
            </>
          ) : (
            'No runs yet'
          )}
        </span>
      }
      isPaused={isPaused}
      canTogglePause
      togglePending={pauseTrigger.isPending || resumeTrigger.isPending}
      onTogglePause={(resume) => {
        if (resume) {
          resumeTrigger.mutate({ triggerId: trigger.id, agentSlug })
        } else {
          pauseTrigger.mutate({ triggerId: trigger.id, agentSlug })
        }
      }}
      onSelect={onSelect}
      onConfirmDelete={() => cancelTrigger.mutate({ id: trigger.id, agentSlug })}
      deletePending={cancelTrigger.isPending}
    />
  )
}
