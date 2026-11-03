import crypto from 'crypto'
import { z } from 'zod'
import { hostState } from '@shared/lib/host-state/backend'

/**
 * Per-agent secrets that authenticate the HOST to the agent's container API
 * (the reverse of PROXY_TOKEN, which authenticates the container/agent to the
 * host and is deliberately agent-visible). The container refuses policy-bearing
 * requests — session creation, sends carrying capabilityPolicies, input
 * resolve/reject — without this token, so an agent can't loosen its own launch
 * policy or self-approve a parked review through the in-container API.
 *
 * Lives in the host data dir (never mounted into containers). Must survive
 * host restarts: containers outlive the host process and keep requiring the
 * token they were started with.
 */
const hostTokensSchema = z.record(z.string(), z.string())
type HostTokens = z.infer<typeof hostTokensSchema>

const FILE_NAME = 'host-container-tokens.json'

function parseTokens(raw: string | null): HostTokens {
  if (raw === null) return {}
  try {
    return hostTokensSchema.parse(JSON.parse(raw))
  } catch (error) {
    console.warn('[host-token-store] Unreadable stored tokens; regenerating tokens:', error)
    return {}
  }
}

function readTokens(): HostTokens {
  let raw: string | null
  try {
    raw = hostState().read(FILE_NAME)
  } catch (error) {
    console.warn('[host-token-store] Unreadable token file; regenerating tokens:', error)
    return {}
  }
  return parseTokens(raw)
}

export function getOrCreateHostToken(agentSlug: string): string {
  const tokens = readTokens()
  const existing = tokens[agentSlug]
  if (existing) return existing

  const token = `hostc_${crypto.randomBytes(32).toString('hex')}`
  // Another request may add a token for this agent first; the save keeps theirs.
  hostState().write(FILE_NAME, (raw) => {
    const current = parseTokens(raw)
    current[agentSlug] ??= token
    return JSON.stringify(current, null, 2)
  })
  return readTokens()[agentSlug]
}

/** The agent's host token as stored, for a container start: waits for the save so a token made in another request at the same time wins over this one. */
export async function hostTokenForStart(agentSlug: string): Promise<string> {
  getOrCreateHostToken(agentSlug)
  await hostState().flush()
  return getOrCreateHostToken(agentSlug)
}
