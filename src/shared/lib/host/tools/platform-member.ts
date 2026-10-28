import { resolvePlatformMemberForCandidates } from '@shared/lib/services/webhook-trigger-service'
import { getStoredPlatformMemberId } from '@shared/lib/services/platform-auth-service'
import { sessionOwnerOf } from './host-tool-result'

/**
 * The platform member a session's webhook calls act as: the session owner
 * first, the stored member as a fallback, and the 'local' placeholder last
 * (opaque platform keys ignore the member suffix entirely).
 */
export async function resolvePlatformMemberForSession(agentSlug: string, sessionId: string): Promise<string> {
  const ownerId = await sessionOwnerOf(agentSlug, sessionId)
  const resolved = await resolvePlatformMemberForCandidates([ownerId])
  return resolved?.memberId ?? getStoredPlatformMemberId() ?? 'local'
}
