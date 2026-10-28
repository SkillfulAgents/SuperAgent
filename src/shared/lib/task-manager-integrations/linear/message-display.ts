import { z } from 'zod'
import type { TaskSnapshot } from '../types'
import {
  INTEGRATION_MESSAGE_LIMITS, clampIntegrationText,
  type IntegrationMessageSource, type IntegrationMessageTask,
} from '../../agent-integrations/message-display-schema'

const named = z.object({ name: z.string() })
// Mirrors the `properties` LinearTasks.snapshot builds; every field is optional
// so a partial or older snapshot still yields a preview.
const linearPropertiesSchema = z.object({
  state: named.extend({ type: z.string() }).nullish(),
  priority: z.number().int().min(0).max(4).nullish(),
  assignee: named.nullish(),
  delegate: named.nullish(),
  team: named.nullish(),
  project: named.nullish(),
  labels: z.array(named).nullish(),
})

// Linear's own priority names.
const PRIORITY_LABELS = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const
const STATUS_CATEGORIES = new Set(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'])

const label = (value: string) => clampIntegrationText(value, INTEGRATION_MESSAGE_LIMITS.label)

/** Issue fields for the app's ticket preview. Unknown shapes yield no fields. */
export function describeLinearIssue(snapshot: TaskSnapshot): IntegrationMessageTask & { status?: IntegrationMessageSource['status'] } {
  const parsed = linearPropertiesSchema.safeParse(snapshot.properties)
  if (!parsed.success) return {}
  const { state, priority, assignee, delegate, team, project, labels } = parsed.data
  return {
    ...(state ? { status: {
      name: label(state.name),
      ...(STATUS_CATEGORIES.has(state.type) ? { category: state.type as NonNullable<IntegrationMessageSource['status']>['category'] } : {}),
    } } : {}),
    ...(priority != null ? { priority: { level: priority, label: PRIORITY_LABELS[priority] } } : {}),
    ...(assignee ? { assignee: label(assignee.name) } : {}),
    ...(delegate ? { delegate: label(delegate.name) } : {}),
    ...(team ? { team: label(team.name) } : {}),
    ...(project ? { project: label(project.name) } : {}),
    ...(labels?.length ? { labels: labels.slice(0, 20).map(entry => label(entry.name)) } : {}),
  }
}
