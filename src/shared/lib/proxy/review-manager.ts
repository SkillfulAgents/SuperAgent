import crypto from 'crypto'
import { broadcastReview } from './review-broadcast'

const REVIEW_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export interface ReviewDetails {
  agentSlug: string
  accountId: string
  toolkit: string
  method: string
  targetPath: string
  matchedScopes: string[]
  scopeDescriptions: Record<string, string>
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
 * Uses scope descriptions when available, otherwise builds from the
 * structured fields — with special handling for MCP tool call paths.
 */
export function generateReviewDisplayText(
  toolkit: string,
  method: string,
  targetPath: string,
  scopeDescriptions: Record<string, string>
): string {
  // Use the first scope description if available — it's usually the best
  // human-readable summary of what the request does.
  const descriptions = Object.values(scopeDescriptions)
  if (descriptions.length > 0) {
    const desc = descriptions[0]
    if (desc.endsWith('?')) return desc
    // Strip leading "allow" (case-insensitive) to avoid "Allow allow..."
    const stripped = desc.replace(/^allow\s+/i, '')
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

  requestReview(details: ReviewDetails, signal?: AbortSignal): Promise<'allow' | 'deny'> {
    const id = crypto.randomUUID()

    return new Promise<'allow' | 'deny'>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Review timeout'))
      }, REVIEW_TIMEOUT_MS)

      const cleanup = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        broadcastReview(details.agentSlug, {
          type: 'proxy_review_resolved',
          reviewId: id,
          decision: 'deny',
        })
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
        details.scopeDescriptions
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
    })
  }

  submitDecision(id: string, decision: 'allow' | 'deny'): boolean {
    const review = this.pending.get(id)
    if (!review) return false

    clearTimeout(review.timer)
    this.pending.delete(id)
    review.resolve(decision)

    // Broadcast resolution so UIs can dismiss the prompt
    broadcastReview(review.details.agentSlug, {
      type: 'proxy_review_resolved',
      reviewId: id,
      decision,
    })

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
          review.details.scopeDescriptions
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

  rejectAll(): void {
    for (const [id, review] of this.pending) {
      clearTimeout(review.timer)
      this.pending.delete(id)
      review.reject(new Error('Review timeout'))
    }
  }
}

export const reviewManager = new ReviewManager()
