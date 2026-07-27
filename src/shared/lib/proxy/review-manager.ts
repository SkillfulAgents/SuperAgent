import crypto from 'crypto'
import { broadcastReview } from './review-broadcast'
import { getScopeLabel, type ScopeLabel } from './scope-metadata'
import { messagePersister } from '@shared/lib/container/message-persister'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import type { PendingUserInputRequest } from '@shared/lib/user-input/request-schema'

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

interface ReviewSettler {
  resolve: (decision: 'allow' | 'deny') => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type ReviewRegistryEntry = Extract<
  PendingUserInputRequest,
  { kind: 'proxy_review' | 'x_agent_review' }
>

export class ReviewManager {
  // The registry (userInputRequestManager) IS the pending-review store — each
  // envelope's payload carries the full ReviewDetails plus displayText. This
  // map holds only what an envelope cannot: the blocked proxied call's promise
  // settlers and the auto-deny timer. An entry without a settler is still a
  // real review (visible, decidable, sweepable); a settler without an entry is
  // a leak the shadow check flags.
  private settlers: Map<string, ReviewSettler> = new Map()

  private shadowSettlerCheck(context: string): void {
    if (process.env.NODE_ENV === 'production') return
    userInputRequestManager.verifyReviewSettlerParity({
      context,
      settlerIds: [...this.settlers.keys()],
    })
  }

  private static isReviewEntry(r: PendingUserInputRequest): r is ReviewRegistryEntry {
    return r.kind === 'proxy_review' || r.kind === 'x_agent_review'
  }

  private reviewEntriesForAgent(agentSlug: string): ReviewRegistryEntry[] {
    return userInputRequestManager
      .getAgentScopedRequests(agentSlug)
      .filter(ReviewManager.isReviewEntry)
  }

  // Rebuild ReviewDetails from an envelope payload. The payload schema is
  // deliberately lenient, so every field gets a safe default; displayText is
  // recomputed when the envelope predates it.
  private static detailsOf(entry: ReviewRegistryEntry): ReviewDetails & { displayText: string } {
    const p = entry.payload as Record<string, unknown>
    const toolkit = typeof p.toolkit === 'string' ? p.toolkit : ''
    const method = typeof p.method === 'string' ? p.method : ''
    const targetPath = typeof p.targetPath === 'string' ? p.targetPath : ''
    const scopeDescriptions =
      p.scopeDescriptions && typeof p.scopeDescriptions === 'object'
        ? (p.scopeDescriptions as Record<string, string>)
        : {}
    const endpointDescription =
      typeof p.endpointDescription === 'string' ? p.endpointDescription : undefined
    const displayText =
      typeof p.displayText === 'string' && p.displayText.length > 0
        ? p.displayText
        : generateReviewDisplayText(toolkit, method, targetPath, scopeDescriptions, endpointDescription)
    return {
      agentSlug: entry.scope.agentSlug ?? '',
      accountId: typeof p.accountId === 'string' ? p.accountId : '',
      toolkit,
      method,
      targetPath,
      matchedScopes: Array.isArray(p.matchedScopes) ? (p.matchedScopes as string[]) : [],
      scopeDescriptions,
      ...(endpointDescription !== undefined ? { endpointDescription } : {}),
      ...(p.xAgent && typeof p.xAgent === 'object'
        ? { xAgent: p.xAgent as ReviewDetails['xAgent'] }
        : {}),
      displayText,
    }
  }

  // The single exit: settles the registry entry, the parked promise (if one
  // exists), the auto-deny timer, and the UI broadcast together, in that
  // order — the registry must be settled before the promise resumes the
  // proxied call, which can re-enter and request another review.
  private settleReview(
    entry: ReviewRegistryEntry,
    outcome: 'answered' | 'declined' | 'cancelled' | 'timeout',
    action: { type: 'resolve'; decision: 'allow' | 'deny' } | { type: 'reject'; error: Error },
  ): void {
    const settler = this.settlers.get(entry.id)
    this.settlers.delete(entry.id)
    if (settler) clearTimeout(settler.timer)
    userInputRequestManager.resolve(entry.id, outcome)
    if (settler) {
      if (action.type === 'resolve') settler.resolve(action.decision)
      else settler.reject(action.error)
    }
    broadcastReview(entry.scope.agentSlug ?? '', {
      type: 'proxy_review_resolved',
      reviewId: entry.id,
      decision: action.type === 'resolve' ? action.decision : 'deny',
    })
  }

  requestReview(details: ReviewDetails, signal?: AbortSignal): Promise<'allow' | 'deny'> {
    const id = crypto.randomUUID()

    return new Promise<'allow' | 'deny'>((resolve, reject) => {
      const settleTimedOut = () => {
        if (!this.settlers.has(id)) return
        this.settlers.delete(id)
        userInputRequestManager.resolve(id, 'timeout')
        this.shadowSettlerCheck('settleTimedOut')
        broadcastReview(details.agentSlug, {
          type: 'proxy_review_resolved',
          reviewId: id,
          decision: 'deny',
        })
        messagePersister.syncAgentSessionsAwaiting(details.agentSlug)
        reject(new Error('Review timeout'))
      }

      const timer = setTimeout(settleTimedOut, REVIEW_TIMEOUT_MS)

      const cleanup = () => {
        clearTimeout(timer)
        this.settlers.delete(id)
        userInputRequestManager.resolve(id, 'cancelled')
        this.shadowSettlerCheck('abortCleanup')
        broadcastReview(details.agentSlug, {
          type: 'proxy_review_resolved',
          reviewId: id,
          decision: 'deny',
        })
        messagePersister.syncAgentSessionsAwaiting(details.agentSlug)
      }

      // If the request is aborted (e.g. task stopped), clean up the orphaned review
      if (signal) {
        signal.addEventListener('abort', () => {
          if (!this.settlers.has(id)) return // already resolved/timed out
          cleanup()
          reject(new Error('Request aborted'))
        }, { once: true })
      }

      this.settlers.set(id, { resolve, reject, timer })

      const displayText = generateReviewDisplayText(
        details.toolkit,
        details.method,
        details.targetPath,
        details.scopeDescriptions,
        details.endpointDescription,
      )

      // Reviews are agent-scoped — no sessionId in the proxied call, so the
      // envelope carries agentSlug only. The registry entry IS the pending
      // review: it makes the agent's sessions read as awaiting, and its
      // payload carries the full details plus the derived display text so
      // every reader (unified wire, dashboard poll, sweeps) renders from it.
      const registered = userInputRequestManager.register({
        id,
        kind: details.xAgent ? 'x_agent_review' : 'proxy_review',
        scope: { agentSlug: details.agentSlug },
        blocking: true,
        autoApproved: false,
        payload: { ...details, displayText },
      })
      if (!registered) {
        // Can't happen with our own envelope construction, but if the registry
        // ever drops it, fail the proxied call now — a review that exists
        // nowhere would otherwise park until the timeout.
        clearTimeout(timer)
        this.settlers.delete(id)
        reject(new Error('Failed to register review'))
        return
      }
      this.shadowSettlerCheck('requestReview')

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

      // Recompute awaiting for the agent's sessions so chat tick / activity
      // strip stop lying "Working…" while the Allow/Deny card is up — the
      // registry entry registered above is what flips them.
      messagePersister.syncAgentSessionsAwaiting(details.agentSlug)

      // The OS notification fires from the registry 'created' transition
      // (persister dispatchRequestNotification) — one per review, attributed
      // to the agent's first active session there.
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
    const entry = userInputRequestManager.getOpenRequest(id)
    // The kind guard is load-bearing: the decision routes accept a
    // caller-supplied id, and resolving whatever the registry holds under it
    // would let a review decision settle a parked secret/question/computer-use
    // wait out from under its own decision flow.
    if (!entry || !ReviewManager.isReviewEntry(entry)) return false
    if (expectedAgentSlug !== undefined && entry.scope.agentSlug !== expectedAgentSlug) {
      // Don't leak existence of the review to an unauthorized caller —
      // return the same `false` shape as "review not found".
      return false
    }

    this.settleReview(entry, decision === 'allow' ? 'answered' : 'declined', {
      type: 'resolve',
      decision,
    })
    this.shadowSettlerCheck('submitDecision')
    if (entry.scope.agentSlug) {
      messagePersister.syncAgentSessionsAwaiting(entry.scope.agentSlug)
    }

    return true
  }

  resolveMatchingPending(
    agentSlug: string,
    scope: string,
    decision: 'allow' | 'deny'
  ): void {
    for (const entry of this.reviewEntriesForAgent(agentSlug)) {
      if (!ReviewManager.detailsOf(entry).matchedScopes.includes(scope)) continue
      this.settleReview(entry, decision === 'allow' ? 'answered' : 'declined', {
        type: 'resolve',
        decision,
      })
    }
    this.shadowSettlerCheck('resolveMatchingPending')
    messagePersister.syncAgentSessionsAwaiting(agentSlug)
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
    for (const entry of this.reviewEntriesForAgent(agentSlug)) {
      const details = ReviewManager.detailsOf(entry)
      const hasLabel = details.matchedScopes.some(
        (s) => getScopeLabel(details.toolkit, s) === label,
      )
      if (!hasLabel) continue
      this.settleReview(entry, decision === 'allow' ? 'answered' : 'declined', {
        type: 'resolve',
        decision,
      })
    }
    this.shadowSettlerCheck('resolveMatchingPendingByLabel')
    messagePersister.syncAgentSessionsAwaiting(agentSlug)
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
    for (const entry of this.reviewEntriesForAgent(agentSlug)) {
      if (ReviewManager.detailsOf(entry).xAgent?.operation !== operation) continue
      this.settleReview(entry, decision === 'allow' ? 'answered' : 'declined', {
        type: 'resolve',
        decision,
      })
    }
    this.shadowSettlerCheck('resolveMatchingXAgentByOperation')
    messagePersister.syncAgentSessionsAwaiting(agentSlug)
  }

  getPendingReviewsForAgent(
    agentSlug: string
  ): Array<{ id: string; displayText: string } & ReviewDetails> {
    return this.reviewEntriesForAgent(agentSlug).map((entry) => ({
      id: entry.id,
      ...ReviewManager.detailsOf(entry),
    }))
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
    for (const entry of this.reviewEntriesForAgent(agentSlug)) {
      this.settleReview(entry, 'declined', { type: 'resolve', decision: 'deny' })
    }
    this.shadowSettlerCheck('denyAllForAgent')
    messagePersister.syncAgentSessionsAwaiting(agentSlug)
  }

  rejectAll(): void {
    const agentSlugs = new Set<string>()
    for (const entry of userInputRequestManager.getOpenRequestsForStore('review')) {
      if (!ReviewManager.isReviewEntry(entry)) continue
      if (entry.scope.agentSlug) agentSlugs.add(entry.scope.agentSlug)
      this.settleReview(entry, 'cancelled', { type: 'reject', error: new Error('Review timeout') })
    }
    // Defensive: a settler whose registry entry vanished is still a parked
    // proxied call — shutdown must never leave one hung.
    for (const [id, settler] of this.settlers) {
      clearTimeout(settler.timer)
      this.settlers.delete(id)
      settler.reject(new Error('Review timeout'))
    }
    for (const agentSlug of agentSlugs) {
      messagePersister.syncAgentSessionsAwaiting(agentSlug)
    }
  }
}

// Use globalThis to persist across Next.js hot reloads in development, matching
// messagePersister. The two are coupled: pending reviews write through to the
// userInputRequestManager registry (which drives the persister's awaiting
// projection), and both singletons survive reloads — so reviewManager must too,
// or a reload would strand its pending reviews in a stale instance.
const globalForReviewManager = globalThis as unknown as {
  reviewManager: ReviewManager | undefined
}

export const reviewManager = globalForReviewManager.reviewManager ?? new ReviewManager()

if (process.env.NODE_ENV !== 'production') {
  globalForReviewManager.reviewManager = reviewManager
}
