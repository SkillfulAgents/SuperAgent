/**
 * What a proxy or x-agent review is about, and how it reads on a card. Pure
 * helpers: the review stores and their router both build on them.
 */
import type { XAgentReview } from './x-agent-review'

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
  xAgent?: XAgentReview
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
