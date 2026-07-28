/**
 * Test fixtures for the unified user-request wire.
 *
 * Built through the registry schema rather than by hand: a card a test accepts
 * has to come from an envelope the registry could really have produced. (That
 * the persister EMITS these at all is proven separately, by the wire-contract
 * suite in chat-integration-e2e.test.ts, which drives a real tool_use through
 * the real MessagePersister.)
 */

import { pendingUserInputRequestSchema } from '@shared/lib/user-input/request-schema'

/** The exact event the persister puts on the wire when a request opens. */
export function createdEvent(
  kind: string,
  payload: Record<string, unknown> = {},
  over: { id?: string; autoApproved?: boolean; sessionId?: string; agentSlug?: string } = {},
) {
  const request = pendingUserInputRequestSchema.parse({
    id: over.id ?? 'tu-1',
    kind,
    scope: {
      agentSlug: over.agentSlug ?? 'test-agent',
      sessionId: over.sessionId ?? 'sess-1',
    },
    blocking: true,
    autoApproved: over.autoApproved ?? false,
    payload,
  })
  return { type: 'user_request_created', agentSlug: request.scope.agentSlug, request }
}
