import { useParams } from '@tanstack/react-router'
import { ScheduledTaskView } from '@renderer/components/scheduled-tasks/scheduled-task-view'
import { useAgentSlug } from './use-agent-slug'

export function TaskRoute() {
  const slug = useAgentSlug()
  const { taskId } = useParams({ strict: false }) as { taskId?: string }
  if (!slug || !taskId) return null
  return <ScheduledTaskView taskId={taskId} agentSlug={slug} />
}
