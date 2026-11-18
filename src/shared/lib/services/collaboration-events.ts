import type { CollaborationEvent } from '@shared/lib/agent-members-schema'
import { isAuthMode } from '@shared/lib/auth/mode'
import { globalFeed, type GlobalFeedEvent } from '@shared/lib/notifications/global-feed'

/**
 * A membership hint, on each recipient's own feed channel: a user removed
 * from the agent no longer follows its channel and must still hear of it.
 * Recipients are resolved by the service at the mutation boundary.
 */
export function publishCollaborationEvent(userIds: Iterable<string>, event: CollaborationEvent): void {
  globalFeed.publishToUsers(userIds, event)
}

/** A membership hint: it can grant or revoke the reader's access, so a stream reloads its agents on it. */
export function isCollaborationEvent(event: GlobalFeedEvent): boolean {
  return event.type === 'agent_members_changed' || event.type === 'agent_access_revoked'
}

/**
 * A new agent, to the members it was created with, once their access rows
 * exist: their streams do not follow its channel yet, and load their agents
 * again on this. In local mode every stream already carries every agent.
 */
export function announceAgentCreated(agentSlug: string, memberIds: Iterable<string>): void {
  const event: GlobalFeedEvent = { type: 'agent_created', agentSlug }
  if (isAuthMode()) globalFeed.publishToUsers(memberIds, event)
  else globalFeed.publish(event)
}
