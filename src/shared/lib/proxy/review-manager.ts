import crypto from 'crypto'
import { broadcastReview } from './review-broadcast'
import { getScopeLabel, type ScopeLabel } from './scope-metadata'
import { messagePersister } from '@shared/lib/container/message-persister'
import { notificationManager } from '@shared/lib/notifications/notification-manager'

const REVIEW_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export interface ReviewDetails {
  agentSlug: string
  accountId: string
  toolkit: string
  method: string
  targetPath: string
  matchedScopes: string[]
  scopeDescriptions: Record<string, string>
  /**
   * Description of the matched API endpoint (what the current call does).
   * Preferred over scopeDescriptions when generating the prompt headline.
   */
  endpointDescription?: string
  // Optional: x-agent review fields.
  // When present, the UI renders a dedicated "Agent X wants to use Agent Y" prompt
  // with a read/invoke level selector. targetAgentSlug is the other agent being acted on.
  xAgent?: {
    targetAgentSlug: string
    targetAgentName: string
    operation: 'list' | 'read' | 'invoke' | 'create'
    // For 'invoke': the prompt being sent. For 'create': the proposed name.
    preview?: string
  }
}

/**
 * Convert a snake_case or kebab-case tool/action name into a gerund phrase.
 * e.g. "list_meetings" → "listing meetings", "get_user_profile" → "getting user profile",
 *      "send_message" → "sending message", "search_contacts" → "searching contacts"
 */
export function humanizeActionName(name: string): string {
  const words = name.replace(/[_-]/g, ' ').trim().split(/\s+/)
  if (words.length === 0 || words[0] === '') return name || 'action'

  // Convert first word (the verb) to gerund form
  const verb = words[0]
  let gerund: string
  if (verb.endsWith('e') && !verb.endsWith('ee')) {
    gerund = verb.slice(0, -1) + 'ing' // e.g. "create" → "creating"
  } else if (/^[a-z]*[bcdfghjklmnpqrstvwxyz][aeiou][bcdfghlmnprstvwz]$/.test(verb) && verb.length <= 4) {
    // Double final consonant for short CVC verbs: "get" → "getting", "run" → "running"
    gerund = verb + verb[verb.length - 1] + 'ing'
  } else {
    gerund = verb + 'ing' // e.g. "list" → "listing", "search" → "searching"
  }

  return [gerund, ...words.slice(1)].join(' ')
}

/**
 * Generate a human-readable display text for a proxy review request.
 *
 * Priority:
 *  1. The matched endpoint description (describes the specific call)
 *  2. The first scope description (fallback when endpoint is uncurated)
 *  3. A generic "Allow <method> request to <Toolkit>?" string
 *
 * Note: do NOT default to scope descriptions for the headline. Scope-level
 * text describes the broad permission (e.g. "Read, compose, send, and
 * permanently delete all your email") and is alarming when the user is
 * actually approving a narrow call (e.g. read profile).
 */
export function generateReviewDisplayText(
  toolkit: string,
  method: string,
  targetPath: string,
  scopeDescriptions: Record<string, string>,
  endpointDescription?: string,
): string {
  const candidate = endpointDescription || Object.values(scopeDescriptions)[0]
  if (candidate) {
    if (candidate.endsWith('?')) return candidate
    // Strip leading "allow" (case-insensitive) to avoid "Allow allow..."
    const stripped = candidate.replace(/^allow\s+/i, '')
    return `Allow ${stripped.charAt(0).toLowerCase()}${stripped.slice(1)}?`
  }

  const toolkitDisplay = toolkit.charAt(0).toUpperCase() + toolkit.slice(1)

  // MCP tool call pattern: "tools/call: <tool_name>" or "tools/call:<tool_name>"
  const mcpMatch = targetPath.match(/tools\/call:\s*(.+)/)
  if (mcpMatch) {
    const action = humanizeActionName(mcpMatch[1])
    return `Allow ${action} via ${toolkitDisplay}?`
  }

  // Fallback: generic description using toolkit name
  return `Allow ${method} request to ${toolkitDisplay}?`
}

interface PendingReview {
  id: string
  details: ReviewDetails
  resolve: (decision: 'allow' | 'deny') => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class ReviewManager {
  private pending: Map<string, PendingReview> = new Map()
  private awaitingBlockerRegistered = false

  // Teach MessagePersister that a parked review counts as "still waiting on the
  // human", so its tool-result clear won't drop the awaiting bit while a review is
  // up. Registered lazily on first review (not at module load): review-manager and
  // message-persister form an import cycle, so the persister singleton isn't ready
  // at module-eval time — mirrors container-manager wiring its callback at startup.
  private ensureAwaitingBlockerRegistered(): void {
    if (this.awaitingBlockerRegistered) return
    this.awaitingBlockerRegistered = true
    messagePersister.registerAwaitingBlockerSource(
      (agentSlug) => this.getPendingReviewsForAgent(agentSlug).length > 0,
    )
  }

  private markAgentSessionsAwaiting(agentSlug: string): void {
    for (const sessionId of messagePersister.getActiveSessionIdsForAgent(agentSlug)) {
      messagePersister.markAwaitingInput(sessionId)
    }
  }

  // Caller deletes the review from `pending` first. No-op while any review remains.
  private clearAgentSessionsAwaitingIfIdle(agentSlug: string): void {
    if (this.getPendingReviewsForAgent(agentSlug).length > 0) return
    messagePersister.clearAwaitingInputForAgentIfUnblocked(agentSlug)
  }

  requestReview(details: ReviewDetails, signal?: AbortSignal): Promise<'allow' | 'deny'> {
    this.ensureAwaitingBlockerRegistered()
    const id = crypto.randomUUID()

    return new Promise<'allow' | 'deny'>((resolve, reject) => {
      const settleTimedOut = () => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        broadcastReview(details.agentSlug, {
          type: 'proxy_review_resolved',
          reviewId: id,
          decision: 'deny',
        })
        this.clearAgentSessionsAwaitingIfIdle(details.agentSlug)
        reject(new Error('Review timeout'))
      }

      const timer = setTimeout(settleTimedOut, REVIEW_TIMEOUT_MS)

      const cleanup = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        broadcastReview(details.agentSlug, {
          type: 'proxy_review_resolved',
          reviewId: id,
          decision: 'deny',
        })
        this.clearAgentSessionsAwaitingIfIdle(details.agentSlug)
      }

      // If the request is aborted (e.g. task stopped), clean up the orphaned review
      if (signal) {
        signal.addEventListener('abort', () => {
          if (!this.pending.has(id)) return // already resolved/timed out
          cleanup()
          reject(new Error('Request aborted'))
        }, { once: true })
      }

      this.pending.set(id, { id, details, resolve, reject, timer })

      const displayText = generateReviewDisplayText(
        details.toolkit,
        details.method,
        details.targetPath,
        details.scopeDescriptions,
        details.endpointDescription,
      )

      // Broadcast review request to agent's active sessions
      broadcastReview(details.agentSlug, {
        type: 'proxy_review_request',
        reviewId: id,
        accountId: details.accountId,
        toolkit: details.toolkit,
        method: details.method,
        targetPath: details.targetPath,
        matchedScopes: details.matchedScopes,
        scopeDescriptions: details.scopeDescriptions,
        displayText,
        ...(details.xAgent ? { xAgent: details.xAgent } : {}),
      })

      // Mark active sessions awaiting so chat tick / activity strip stop lying
      // "Working…" while the Allow/Deny card is up.
      this.markAgentSessionsAwaiting(details.agentSlug)

      // Fire ONE OS notification per review, attributed to the first active
      // session of this agent. The proxy call is agent-scoped (no sessionId
      // in the request), so we pick an active session — same attribution
      // heuristic the sidebar uses for its orange dot (agents.ts:
      // isActive && hasAgentLevelReviews). Whether the OS popup actually
      // shows is the renderer's call — it knows OS focus + per-user viewing
      // + `notifyWhenUnfocused`. An open SSE connection ≠ actively looking
      // at the screen.
      const targetSessionId = messagePersister.getActiveSessionIdsForAgent(details.agentSlug)[0]
      if (targetSessionId) {
        const kind = details.xAgent ? 'agent_action' : 'api_request'
        notificationManager
          .triggerSessionApiReviewWaiting(targetSessionId, details.agentSlug, id, displayText, undefined, kind)
          .catch((err) => {
            console.error('[ReviewManager] Failed to trigger API review notification:', err)
          })
      }
    })
  }

  /**
   * Resolve a pending review.
   *
   * `expectedAgentSlug` MUST be passed when the call originates from an
   * HTTP route — it guards against a user with role on agent A submitting
   * a decision for agent B's review by sending B's reviewId to A's URL.
   * Internal callers (e.g. `resolveMatchingPending`, which already filters
   * by agentSlug itself) may omit it.
   */
  submitDecision(id: string, decision: 'allow' | 'deny', expectedAgentSlug?: string): boolean {
    const review = this.pending.get(id)
    if (!review) return false
    if (expectedAgentSlug !== undefined && review.details.agentSlug !== expectedAgentSlug) {
      // Don't leak existence of the review to an unauthorized caller —
      // return the same `false` shape as "review not found".
      return false
    }

    clearTimeout(review.timer)
    this.pending.delete(id)
    review.resolve(decision)

    // Broadcast resolution so UIs can dismiss the prompt
    broadcastReview(review.details.agentSlug, {
      type: 'proxy_review_resolved',
      reviewId: id,
      decision,
    })
    this.clearAgentSessionsAwaitingIfIdle(review.details.agentSlug)

    return true
  }

  resolveMatchingPending(
    agentSlug: string,
    scope: string,
    decision: 'allow' | 'deny'
  ): void {
    for (const [id, review] of this.pending) {
      if (
        review.details.agentSlug === agentSlug &&
        review.details.matchedScopes.includes(scope)
      ) {
        clearTimeout(review.timer)
        this.pending.delete(id)
        review.resolve(decision)

        broadcastReview(agentSlug, {
          type: 'proxy_review_resolved',
          reviewId: id,
          decision,
        })
      }
    }
    this.clearAgentSessionsAwaitingIfIdle(agentSlug)
  }

  /**
   * Resolve every pending API review for `agentSlug` whose matched scopes include
   * one carrying the given risk label. Used when the user picks "Allow all <label>"
   * — the saved policy is a label sentinel ('*read'/'*write'/'*destructive') that
   * `resolveMatchingPending` (exact scope match) can't catch, so sibling same-label
   * prompts would otherwise sit until they time out.
   */
  resolveMatchingPendingByLabel(
    agentSlug: string,
    label: ScopeLabel,
    decision: 'allow' | 'deny',
  ): void {
    for (const [id, review] of this.pending) {
      if (review.details.agentSlug !== agentSlug) continue
      const hasLabel = review.details.matchedScopes.some(
        (s) => getScopeLabel(review.details.toolkit, s) === label,
      )
      if (!hasLabel) continue
      clearTimeout(review.timer)
      this.pending.delete(id)
      review.resolve(decision)
      broadcastReview(agentSlug, {
        type: 'proxy_review_resolved',
        reviewId: id,
        decision,
      })
    }
    this.clearAgentSessionsAwaitingIfIdle(agentSlug)
  }

  /**
   * Resolve every pending x-agent review for `agentSlug` whose operation matches.
   * Used when the user picks "always allow for all agents" — the saved policy has
   * targetSlug=null, so the per-target scope match in resolveMatchingPending
   * wouldn't catch sibling pending prompts (e.g. read:bob while saving global read).
   */
  resolveMatchingXAgentByOperation(
    agentSlug: string,
    operation: 'list' | 'read' | 'invoke' | 'create',
    decision: 'allow' | 'deny',
  ): void {
    for (const [id, review] of this.pending) {
      if (
        review.details.agentSlug === agentSlug &&
        review.details.xAgent?.operation === operation
      ) {
        clearTimeout(review.timer)
        this.pending.delete(id)
        review.resolve(decision)

        broadcastReview(agentSlug, {
          type: 'proxy_review_resolved',
          reviewId: id,
          decision,
        })
      }
    }
    this.clearAgentSessionsAwaitingIfIdle(agentSlug)
  }

  getPendingReviewsForAgent(
    agentSlug: string
  ): Array<{ id: string; displayText: string } & ReviewDetails> {
    const results: Array<{ id: string; displayText: string } & ReviewDetails> = []
    for (const review of this.pending.values()) {
      if (review.details.agentSlug === agentSlug) {
        const displayText = generateReviewDisplayText(
          review.details.toolkit,
          review.details.method,
          review.details.targetPath,
          review.details.scopeDescriptions,
          review.details.endpointDescription,
        )
        results.push({ id: review.id, displayText, ...review.details })
      }
    }
    return results
  }

  /**
   * Convenience helper for x-agent reviews. Wraps requestReview with a stable
   * scopeDescriptions/displayText that the dedicated UI renderer keys off.
   */
  requestXAgentReview(
    callerAgentSlug: string,
    targetAgentSlug: string,
    targetAgentName: string,
    operation: 'list' | 'read' | 'invoke' | 'create',
    preview?: string,
    signal?: AbortSignal,
  ): Promise<'allow' | 'deny'> {
    const scope =
      operation === 'list'
        ? 'list'
        : operation === 'create'
          ? 'create'
          : `${operation}:${targetAgentSlug}`
    const description =
      operation === 'create'
        ? `Allow agent to create a new agent named "${targetAgentName}"?`
        : operation === 'list'
          ? `Allow agent to list other agents in this workspace?`
          : operation === 'invoke'
            ? `Allow agent to send a message to "${targetAgentName}"?`
            : `Allow agent to read sessions of "${targetAgentName}"?`

    return this.requestReview(
      {
        agentSlug: callerAgentSlug,
        // Reuse fields semantically — accountId carries target slug for "always allow X" routing
        accountId: targetAgentSlug,
        toolkit: 'agents',
        method: operation,
        targetPath: `agents:${operation}:${targetAgentSlug}`,
        matchedScopes: [scope],
        scopeDescriptions: { [scope]: description },
        xAgent: {
          targetAgentSlug,
          targetAgentName,
          operation,
          preview,
        },
      },
      signal,
    )
  }

  denyAllForAgent(agentSlug: string): void {
    for (const [id, review] of this.pending) {
      if (review.details.agentSlug !== agentSlug) continue
      clearTimeout(review.timer)
      this.pending.delete(id)
      review.resolve('deny')

      broadcastReview(agentSlug, {
        type: 'proxy_review_resolved',
        reviewId: id,
        decision: 'deny',
      })
    }
    this.clearAgentSessionsAwaitingIfIdle(agentSlug)
  }

  rejectAll(): void {
    const agentSlugs = new Set<string>()
    for (const [id, review] of this.pending) {
      clearTimeout(review.timer)
      this.pending.delete(id)
      agentSlugs.add(review.details.agentSlug)
      broadcastReview(review.details.agentSlug, {
        type: 'proxy_review_resolved',
        reviewId: id,
        decision: 'deny',
      })
      review.reject(new Error('Review timeout'))
    }
    for (const agentSlug of agentSlugs) {
      this.clearAgentSessionsAwaitingIfIdle(agentSlug)
    }
  }
}

// Use globalThis to persist across Next.js hot reloads in development, matching
// messagePersister. The two are coupled: reviewManager registers an awaiting-blocker
// source on the persister, and the persister survives reloads — so reviewManager must
// too, or each reload leaks a new stale predicate into the persister's blocker set.
const globalForReviewManager = globalThis as unknown as {
  reviewManager: ReviewManager | undefined
}

export const reviewManager = globalForReviewManager.reviewManager ?? new ReviewManager()

if (process.env.NODE_ENV !== 'production') {
  globalForReviewManager.reviewManager = reviewManager
}
