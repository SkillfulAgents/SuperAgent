import { useMemo, useState, type ReactNode } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSwitchItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import {
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
  useCompletedOneTimeSessions,
} from '@renderer/hooks/use-scheduled-tasks'
import {
  useWebhookTriggers,
  useCancelWebhookTrigger,
  usePauseWebhookTrigger,
  useResumeWebhookTrigger,
  type WebhookTrigger,
} from '@renderer/hooks/use-webhook-triggers'
import { formatDistanceToNow } from 'date-fns'
import { HomeCollapsible } from './home-collapsible'
import { IntegrationRow, RowHoverChevron } from '@renderer/components/connections/integration-row'
import type { ApiScheduledTask } from '@shared/lib/types/api'
import { useAgentActivityStats } from '@renderer/hooks/use-activity-stats'
import { ActivitySparkChart, ActivitySparkChartSkeleton, CronSparkChart } from '@renderer/components/activity/activity-spark-chart'
import type { CronActivityPoint, DailyActivityPoint } from '@shared/lib/types/activity'

interface HomeTriggersProps {
  agentSlug: string
  scheduledTasks: ApiScheduledTask[]
  onSelectTask: (taskId: string) => void
  onSelectWebhook: (webhookId: string) => void
  onSelectInboundXAgent: () => void
  onSelectCompletedTasks: () => void
  className?: string
}

type DeletableTriggerItem =
  | { kind: 'cron'; createdAtMs: number; task: ApiScheduledTask }
  | { kind: 'webhook'; createdAtMs: number; trigger: WebhookTrigger }

type TriggerItem =
  | DeletableTriggerItem
  | { kind: 'inbound-x-agent'; createdAtMs: number }

export function HomeTriggers({
  agentSlug,
  scheduledTasks,
  onSelectTask,
  onSelectWebhook,
  onSelectInboundXAgent,
  onSelectCompletedTasks,
  className,
}: HomeTriggersProps) {
  const { data: webhookTriggersData } = useWebhookTriggers(agentSlug, 'active')
  const { data: cancelledWebhooksData } = useWebhookTriggers(agentSlug, 'cancelled')
  const { data: cancelledTasksData } = useScheduledTasks(agentSlug, 'cancelled')
  const { data: completedSessionsData } = useCompletedOneTimeSessions(agentSlug)
  const { data: activityStats, isPending: activityPending } = useAgentActivityStats(agentSlug)
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
    const inboundItems: TriggerItem[] = activityStats?.inboundXAgent.total
      ? [{
          kind: 'inbound-x-agent',
          createdAtMs: activityStats.inboundXAgent.lastInvokedAt
            ? new Date(activityStats.inboundXAgent.lastInvokedAt).getTime()
            : 0,
        }]
      : []
    return [...cronItems, ...webhookItems, ...inboundItems]
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
  }, [scheduledTasks, webhookTriggersData, activityStats?.inboundXAgent])

  const deletedItems = useMemo<DeletableTriggerItem[]>(() => {
    const cronItems: DeletableTriggerItem[] = (Array.isArray(cancelledTasksData) ? cancelledTasksData : []).map((task) => ({
      kind: 'cron',
      createdAtMs: new Date(task.createdAt).getTime(),
      task,
    }))
    const webhookItems: DeletableTriggerItem[] = (Array.isArray(cancelledWebhooksData) ? cancelledWebhooksData : []).map((trigger) => ({
      kind: 'webhook',
      createdAtMs: new Date(trigger.createdAt).getTime(),
      trigger,
    }))
    return [...cronItems, ...webhookItems].sort((a, b) => b.createdAtMs - a.createdAtMs)
  }, [cancelledTasksData, cancelledWebhooksData])

  const completedCount = completedSessionsData?.length ?? 0
  const hasDeleted = deletedItems.length > 0
  const hasCompleted = completedCount > 0

  return (
    <HomeCollapsible title="Triggers" className={className}>
      {items.length > 0 || hasDeleted || hasCompleted ? (
        <div className="mt-2 divide-y divide-border/50">
          {items.map((item) =>
            item.kind === 'cron' ? (
              <CronRow
                key={`c-${item.task.id}`}
                task={item.task}
                agentSlug={agentSlug}
                onSelect={() => onSelectTask(item.task.id)}
                activity={activityStats?.cronByTaskId[item.task.id]}
                activityPending={activityPending}
              />
            ) : item.kind === 'webhook' ? (
              <WebhookRow
                key={`w-${item.trigger.id}`}
                trigger={item.trigger}
                agentSlug={agentSlug}
                onSelect={() => onSelectWebhook(item.trigger.id)}
                activity={activityStats?.webhookByTriggerId[item.trigger.id]}
                activityPending={activityPending}
              />
            ) : (
              <InboundXAgentRow
                key="inbound-x-agent"
                total={activityStats!.inboundXAgent.total}
                lastInvokedAt={activityStats!.inboundXAgent.lastInvokedAt}
                activity={activityStats!.inboundXAgent.activity}
                onSelect={onSelectInboundXAgent}
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
                  <CronRow
                    key={`c-del-${item.task.id}`}
                    task={item.task}
                    agentSlug={agentSlug}
                    onSelect={() => onSelectTask(item.task.id)}
                    activity={activityStats?.cronByTaskId[item.task.id]}
                    activityPending={activityPending}
                  />
                ) : (
                  <WebhookRow
                    key={`w-del-${item.trigger.id}`}
                    trigger={item.trigger}
                    agentSlug={agentSlug}
                    onSelect={() => onSelectWebhook(item.trigger.id)}
                    activity={activityStats?.webhookByTriggerId[item.trigger.id]}
                    activityPending={activityPending}
                  />
                ),
              )}
            </>
          )}
          {hasCompleted && (
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-3 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              onClick={onSelectCompletedTasks}
              aria-label={`View ${completedCount} completed one-time ${completedCount === 1 ? 'session' : 'sessions'}`}
            >
              <span>Completed ({completedCount})</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
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
  /** One line: the trigger kind, then its next/last run. Nothing else. */
  subtitle: ReactNode
  isPaused: boolean
  canTogglePause: boolean
  togglePending: boolean
  onTogglePause: (resume: boolean) => void
  onSelect: () => void
  onConfirmDelete: () => void
  deletePending: boolean
  // 'cron' | 'webhook' — drives copy in the menu, dialog, and aria-labels.
  kind: 'cron' | 'webhook'
  // Cron-only Run Now action.
  onRunNow?: () => void
  runNowPending?: boolean
  // When true, the trigger is already deleted — only the View Details action is shown.
  isDeleted?: boolean
  activityChart?: ReactNode
}

/**
 * One trigger on the agent home. Same row as a connection (`IntegrationRow`,
 * no icon): click opens the detail view, a chevron slides in on hover, and the
 * management actions (pause/resume, run now, delete) live in a right-click /
 * long-press context menu rather than an inline button.
 */
function TriggerRow({
  name,
  subtitle,
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
  activityChart,
}: TriggerRowProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const label = kind === 'cron' ? 'Cron' : 'Webhook'

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <IntegrationRow
            icon={null}
            name={name}
            muted={isDeleted}
            nameBadge={isPaused ? (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0 rounded-full bg-muted text-muted-foreground">
                <Pause className="h-2.5 w-2.5 fill-current" />
                Paused
              </span>
            ) : undefined}
            subtitle={<span className="truncate">{subtitle}</span>}
            onActivate={onSelect}
            data-testid={`home-trigger-row-${kind}`}
            right={
              <>
                {activityChart}
                <RowHoverChevron />
              </>
            }
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44" data-testid="home-trigger-menu">
          {canTogglePause && !isDeleted && (
            <>
              <ContextMenuSwitchItem
                checked={!isPaused}
                disabled={togglePending}
                onCheckedChange={(checked) => onTogglePause(checked)}
              >
                {isPaused ? <Pause className="h-4 w-4 mr-2" /> : <Play className="h-4 w-4 mr-2" />}
                Active
              </ContextMenuSwitchItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onClick={onSelect}>
            <Info className="h-4 w-4 mr-2" />
            View Details
          </ContextMenuItem>
          {onRunNow && !isDeleted && (
            <ContextMenuItem disabled={runNowPending} onClick={onRunNow}>
              <Play className="h-4 w-4 mr-2 fill-current" />
              {runNowPending ? 'Running...' : 'Run Now'}
            </ContextMenuItem>
          )}
          {!isDeleted && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                onClick={() => setShowDeleteDialog(true)}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete {label}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

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

function InboundXAgentRow({
  total,
  lastInvokedAt,
  activity,
  onSelect,
}: {
  total: number
  lastInvokedAt: string | null
  activity: DailyActivityPoint[]
  onSelect: () => void
}) {
  return (
    <IntegrationRow
      icon={null}
      name="Called from Other Agents"
      subtitle={
        <span className="truncate">
          {total} {total === 1 ? 'run' : 'runs'}
          {lastInvokedAt && (
            <> · last run {formatDistanceToNow(new Date(lastInvokedAt), { addSuffix: true })}</>
          )}
        </span>
      }
      onActivate={onSelect}
      data-testid="home-trigger-row-inbound-x-agent"
      right={
        <>
          <ActivitySparkChart label="Invocations" data={activity} />
          <RowHoverChevron />
        </>
      }
    />
  )
}

function CronRow({
  task,
  agentSlug,
  onSelect,
  activity,
  activityPending,
}: {
  task: ApiScheduledTask
  agentSlug: string
  onSelect: () => void
  activity?: CronActivityPoint[]
  activityPending?: boolean
}) {
  const runNow = useRunScheduledTaskNow()
  const cancelTask = useCancelScheduledTask()
  const pauseTask = usePauseScheduledTask()
  const resumeTask = useResumeScheduledTask()
  const isPaused = task.status === 'paused'
  const isDeleted = task.status === 'cancelled'

  return (
    <TriggerRow
      kind="cron"
      isDeleted={isDeleted}
      name={task.name ?? 'Scheduled Task'}
      subtitle={
        <>
          cron
          {task.nextExecutionAt && !isPaused ? (
            <> · next run {formatDistanceToNow(new Date(task.nextExecutionAt), { addSuffix: true })}</>
          ) : null}
        </>
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
      activityChart={activity !== undefined ? (
        <CronSparkChart label={`${task.name ?? 'Scheduled Task'} schedule`} data={activity} />
      ) : activityPending ? (
        <ActivitySparkChartSkeleton />
      ) : undefined}
    />
  )
}

function WebhookRow({
  trigger,
  agentSlug,
  onSelect,
  activity,
  activityPending,
}: {
  trigger: WebhookTrigger
  agentSlug: string
  onSelect: () => void
  activity?: DailyActivityPoint[]
  activityPending?: boolean
}) {
  const cancelTrigger = useCancelWebhookTrigger()
  const pauseTrigger = usePauseWebhookTrigger()
  const resumeTrigger = useResumeWebhookTrigger()
  const isPaused = trigger.status === 'paused'
  const isDeleted = trigger.status === 'cancelled'
  const displayName = trigger.name ?? trigger.triggerType

  return (
    <TriggerRow
      kind="webhook"
      isDeleted={isDeleted}
      name={displayName}
      subtitle={
        <>
          webhook
          {trigger.lastFiredAt
            ? <> · last run {formatDistanceToNow(new Date(trigger.lastFiredAt), { addSuffix: true })}</>
            : <> · no runs yet</>}
        </>
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
      activityChart={activity !== undefined ? (
        <ActivitySparkChart label={`${displayName} activity`} data={activity} />
      ) : activityPending ? (
        <ActivitySparkChartSkeleton />
      ) : undefined}
    />
  )
}
