import type { ApiSession } from '@shared/lib/types/api'
import type { AutomationSessionInfo } from '@renderer/hooks/use-agent-automations'
import { toSessionItem, type SessionItem } from '@renderer/components/sessions/related-sessions'

/** How many sessions the home page's Recent sessions shows. */
export const RECENT_SESSIONS = 3

/**
 * Whether a person started this session: not a scheduled run or a webhook, not another agent messaging Team Brain to
 * add what it learned, and not an automatic widget repair.
 */
function startedByPerson(session: ApiSession): boolean {
  return !session.scheduledTaskId && !session.webhookTriggerId && !session.invokedByAgentSlug && !session.isWidgetRepair
}

const activityOf = (session: SessionItem) => Date.parse(session.lastActivityAt ?? session.createdAt) || 0

/**
 * Team Brain's recent sessions on its home page: the ones a person started (`chats`, the agent's own list, which
 * already leaves its scheduled runs out) and any scheduled run (`runs`) waiting on someone. Those waiting come first,
 * then the most recent, `count` in all.
 */
export function recentSessions(chats: readonly ApiSession[], runs: readonly AutomationSessionInfo[], count = RECENT_SESSIONS): SessionItem[] {
  const waitingRuns: SessionItem[] = runs.filter((run) => run.isAwaitingInput)
  const seen = new Set<string>()
  const all = [...chats.filter(startedByPerson).map(toSessionItem), ...waitingRuns].filter((session) => {
    if (seen.has(session.id)) return false
    seen.add(session.id)
    return true
  })
  return all
    .sort((a, b) => Number(!!b.isAwaitingInput) - Number(!!a.isAwaitingInput) || activityOf(b) - activityOf(a))
    .slice(0, count)
}
