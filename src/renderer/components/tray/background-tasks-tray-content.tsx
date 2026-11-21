import { useMemo } from 'react'
import { ArrowLeft, Radio, Square, SquareTerminal } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { useMessages, useStopBackgroundTask } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useElapsedTimer } from '@renderer/hooks/use-elapsed-timer'
import { useWorkflow } from '@renderer/context/workflow-context'
import { collectBackgroundTasks, type BackgroundTaskEntry } from './background-tasks'
import { TRAY_BODY_CLASS } from './tray-card'

function TaskIcon({ task, className }: { task: BackgroundTaskEntry; className?: string }) {
  const Icon = task.kind === 'monitor' ? Radio : SquareTerminal
  return <Icon className={cn('h-4 w-4 shrink-0 text-muted-foreground', className)} />
}

function title(task: BackgroundTaskEntry): string {
  return task.kind === 'monitor' ? 'Monitor' : 'Background command'
}

function Elapsed({ task }: { task: BackgroundTaskEntry }) {
  const elapsed = useElapsedTimer(task.running && task.startedAt ? new Date(task.startedAt) : null)
  if (task.running) return <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{elapsed}</span>
  if (!task.startedAt) return null
  return (
    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
      {new Date(task.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
    </span>
  )
}

function TaskRow({ task, onOpen }: { task: BackgroundTaskEntry; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-item px-2 py-2 text-left transition-colors hover:bg-muted/60"
        data-testid="background-task-list-row"
        data-task-id={task.taskId}
      >
        <TaskIcon task={task} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]/5 text-foreground">{title(task)}</span>
          {task.detail && <span className={cn('block truncate text-xs text-muted-foreground', task.kind === 'command' && 'font-mono')}>{task.detail}</span>}
        </span>
        <Elapsed task={task} />
      </button>
    </li>
  )
}

function TaskDetail({ task, agentSlug, sessionId, onBack }: { task: BackgroundTaskEntry; agentSlug: string; sessionId: string; onBack: () => void }) {
  const stop = useStopBackgroundTask()
  return (
    <div className="flex flex-1 min-h-0 flex-col" data-testid="background-task-detail">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="All background tasks"
          className="rounded-icon p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          data-testid="background-task-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title(task)}</span>
        <span className={cn('shrink-0 text-xs', task.running ? 'text-blue-500' : 'text-muted-foreground')} data-testid="background-task-status">
          {task.running ? 'Running' : task.endReason ?? 'Done'}
        </span>
        {task.running && (
          <button
            type="button"
            onClick={() => stop.mutate({ sessionId, agentSlug, taskId: task.taskId })}
            disabled={stop.isPending}
            className="inline-flex items-center gap-1 rounded-control px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            data-testid="background-task-stop"
          >
            <Square className="h-3 w-3 fill-current" />
            Stop
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-4 pb-4">
        {task.detail && (
          <section>
            <h3 className="text-xs text-muted-foreground">{task.kind === 'monitor' ? 'Watching' : 'Command'}</h3>
            <pre className={cn('mt-1.5 whitespace-pre-wrap break-words rounded-item bg-muted/60 px-3 py-2 text-xs text-foreground', task.kind === 'command' && 'font-mono')}>
              {task.detail}
            </pre>
          </section>
        )}
        <section className="mt-4">
          <h3 className="text-xs text-muted-foreground">{task.kind === 'monitor' ? 'Events' : 'Output'}</h3>
          {task.output ? (
            <pre className="mt-1.5 whitespace-pre-wrap break-words rounded-item bg-muted/60 px-3 py-2 font-mono text-xs text-foreground" data-testid="background-task-output">
              {task.output}
            </pre>
          ) : (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {task.kind === 'monitor' ? 'No events yet.' : 'The agent has not read its output yet.'}
            </p>
          )}
        </section>
      </div>
    </div>
  )
}

/**
 * The drawer's Background tasks tab: the session's background commands and
 * monitors, Running then Done, drilling into one with its command, the output
 * the agent read, and a stop control while it runs.
 */
export function BackgroundTasksTrayContent({ agentSlug, sessionId }: { agentSlug: string; sessionId: string }) {
  const { background, viewBackgroundTask } = useWorkflow()
  const { data: messages } = useMessages(sessionId, agentSlug)
  const { backgroundTasks } = useMessageStream(sessionId, agentSlug, ['backgroundTasks'])
  const tasks = useMemo(() => collectBackgroundTasks(messages, backgroundTasks), [messages, backgroundTasks])
  const viewed = background.viewing ? tasks.find(task => task.taskId === background.viewing) : undefined
  const running = tasks.filter(task => task.running)
  const done = tasks.filter(task => !task.running)

  return (
    <div className={TRAY_BODY_CLASS} data-testid="background-tasks-tray">
      {viewed ? (
        <TaskDetail key={viewed.taskId} task={viewed} agentSlug={agentSlug} sessionId={sessionId} onBack={() => viewBackgroundTask(null)} />
      ) : (
        <div className="flex-1 min-h-0 overflow-auto px-3 pb-4 pt-3" data-testid="background-tasks-list">
          {tasks.length === 0 && <p className="px-2 py-1 text-sm text-muted-foreground">No background tasks in this session yet.</p>}
          {running.length > 0 && (
            <section data-testid="background-tasks-running">
              <h3 className="px-2 py-1 text-xs text-muted-foreground">Running · {running.length}</h3>
              <ul>{running.map(task => <TaskRow key={task.taskId} task={task} onOpen={() => viewBackgroundTask(task.taskId)} />)}</ul>
            </section>
          )}
          {done.length > 0 && (
            <section className={running.length > 0 ? 'mt-3' : undefined} data-testid="background-tasks-done">
              <h3 className="px-2 py-1 text-xs text-muted-foreground">Done · {done.length}</h3>
              <ul>{done.map(task => <TaskRow key={task.taskId} task={task} onOpen={() => viewBackgroundTask(task.taskId)} />)}</ul>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
