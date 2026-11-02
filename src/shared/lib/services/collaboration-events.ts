import type { CollaborationEvent } from '@shared/lib/agent-members-schema'
import { globalFeed } from '@shared/lib/notifications/global-feed'

/** Recipients are resolved by the service at the mutation boundary. */
export function publishCollaborationEvent(userIds: Iterable<string>, event: CollaborationEvent): void {
  for (const userId of new Set(userIds)) globalFeed.publish({ ...event, recipientUserId: userId })
}

export function isCollaborationEvent(event: { type: string }): boolean {
  return event.type === 'agent_members_changed' || event.type === 'agent_access_revoked'
}
