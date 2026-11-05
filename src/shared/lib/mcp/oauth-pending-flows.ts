/**
 * MCP OAuth sign-ins between their start and their callback. They live in
 * AppState, so the callback can reach any process serving the tenant, and a
 * flow is answered once however many callbacks arrive for it.
 * docs/app-state.md § MCP OAuth pending flows describes the life of a flow.
 */
import { randomUUID } from 'node:crypto'
import { appState, defineNamespace, digestKeyPart, type Entry, type Revision, type StateKey } from '@shared/lib/app-state'
import {
  mcpOAuthFlowRecordSchema,
  type McpOAuthDelivery,
  type McpOAuthFlowRecord,
  type McpOAuthIssuerCheck,
  type PendingMcpOAuthFlow,
} from './oauth-pending-flow-schema'

/** How long a started sign-in waits for its callback. */
export const MCP_OAUTH_FLOW_TTL_MS = 15 * 60_000
/** The longest the token request may take, from sending it to reading its answer. */
export const MCP_OAUTH_EXCHANGE_TIMEOUT_MS = 30_000
/**
 * How long a claim keeps the flow when its holder neither finishes nor
 * releases it (a process that died mid-exchange). The record expires then, so
 * the flow ends instead of waiting out the rest of its 15 minutes.
 */
export const MCP_OAUTH_CLAIM_TTL_MS = 60_000
/** Kept for the write that finishes the flow, after the exchange. */
const FINISH_MARGIN_MS = 10_000
/** Each conflict means another write landed; a flow has only a few writers. */
const MAX_DECISIONS = 8
const FINISH_ATTEMPTS = 3

/**
 * The ticket's `oauth:mcp:H(state)`: namespace `oauth:mcp`, keyed by a digest
 * of `state`. `keep`: no write moves a flow's 15-minute deadline except the
 * ones that say so (a claim's own lapse, a finished flow's tombstone).
 */
const flows = defineNamespace({
  name: 'oauth:mcp',
  consistency: 'strong',
  schema: mcpOAuthFlowRecordSchema,
  expiry: { ttlMs: MCP_OAUTH_FLOW_TTL_MS, onUpdate: 'keep' },
})

/** The flow's key. `state` is a bearer value, so the key holds only its digest. */
export function mcpOAuthFlowKey(state: string): StateKey<McpOAuthFlowRecord, 'strong'> {
  return flows.key(digestKeyPart(state))
}

/** Records a started flow. `state` is 128 random bits, so it is never taken. */
export async function savePendingFlow(state: string, flow: Omit<PendingMcpOAuthFlow, 'state'>): Promise<void> {
  const saved = await appState().insertIfAbsent(mcpOAuthFlowKey(state), { state: 'pending', ...flow })
  if (!saved.inserted) throw new Error('An MCP OAuth flow with this state already exists')
}

export type IssuerValidation = { valid: true } | { valid: false; error: string }

/** RFC 9207: a callback's `iss` against what the flow's authorization server said about itself. */
export function validateIssuer(check: McpOAuthIssuerCheck, iss: string | null | undefined): IssuerValidation {
  const hasIss = iss !== undefined && iss !== null
  if (check.required && !hasIss) return { valid: false, error: 'Missing OAuth issuer parameter' }
  if (!hasIss) return { valid: true }
  if (!check.expected) return { valid: false, error: 'Missing expected OAuth issuer' }
  // Simple string comparison, no URI normalization (RFC 9207 §2.4).
  if (iss !== check.expected) return { valid: false, error: 'OAuth issuer mismatch' }
  return { valid: true }
}

/** Why a callback did not get the flow. */
export type McpOAuthRefusal =
  /** No flow under this state: never started, expired, or its claim lapsed. */
  | 'missing'
  /** The callback's `iss` does not match. The flow is left as it was. */
  | 'issuer'
  /** Another callback holds the flow's claim. */
  | 'in-progress'
  /** Another callback, or an error response, has already used the flow. */
  | 'used'
  /** AppState could not be read or written. */
  | 'unavailable'
  /** The claim was answered too late to exchange inside it; the flow was given back unused. */
  | 'late'

/** What the user is told, without a trailing period: the callback page adds its own. */
const REFUSAL_MESSAGES: Record<McpOAuthRefusal, string> = {
  missing: 'This sign-in has expired or was already used. Start the connection again',
  issuer: 'The sign-in response did not come from the expected authorization server',
  'in-progress': 'This sign-in is already being completed',
  used: 'This sign-in was already used. Start the connection again if it did not connect',
  unavailable: 'Could not finish the sign-in. Try again',
  late: 'Could not finish the sign-in in time. Try again',
}

export interface McpOAuthClaimRefused {
  readonly claimed: false
  readonly refusal: McpOAuthRefusal
  /** For the user. */
  readonly error: string
  /** For a refusal decided from a stored flow: how to hand the answer back. */
  readonly delivery?: McpOAuthDelivery
  /** For `issuer`: which check failed, for the log. */
  readonly detail?: string
}

/** The one callback allowed to exchange the flow's code. */
export interface McpOAuthClaim {
  readonly key: StateKey<McpOAuthFlowRecord, 'strong'>
  readonly owner: string
  /** The claim's write; finishing or releasing it is conditional on it. */
  readonly revision: Revision
  /** By this process's clock: the claim was sent before this, plus its TTL, so it is held until then. */
  readonly heldUntil: number
  /** The flow as claimed: the exchange is decided from this snapshot, never from a later read. */
  readonly flow: PendingMcpOAuthFlow
  /** The pending flow's own deadline, which a released flow goes back to. */
  readonly flowExpiresAt: number | null
}

export type McpOAuthClaimResult = { readonly claimed: true; readonly claim: McpOAuthClaim } | McpOAuthClaimRefused

function refuse(refusal: McpOAuthRefusal, delivery?: McpOAuthDelivery, detail?: string): McpOAuthClaimRefused {
  return { claimed: false, refusal, error: REFUSAL_MESSAGES[refusal], ...(delivery ? { delivery } : {}), ...(detail ? { detail } : {}) }
}

/**
 * Takes the flow under `state` for one callback, or says why not. The state
 * and the issuer are checked against what is stored before anything is
 * written, so a callback with the wrong issuer leaves the flow as it was. The
 * claim is a compare-and-set from `pending`: of any number of callbacks, on
 * any processes, one gets it.
 *
 * A claim is held for `MCP_OAUTH_CLAIM_TTL_MS`, and the exchange fits in it
 * (`MCP_OAUTH_EXCHANGE_TIMEOUT_MS` plus a margin for the finishing write). A
 * claim answered too late for that is given back before any code is sent.
 */
export async function claimPendingFlow(state: string, iss: string | null | undefined): Promise<McpOAuthClaimResult> {
  const key = mcpOAuthFlowKey(state)
  const owner = randomUUID()
  let current: Entry<McpOAuthFlowRecord> | null
  try {
    current = await appState().get(key)
  } catch (error) {
    console.error('[mcp/oauth] Could not read the pending flow:', error)
    return refuse('unavailable')
  }
  for (let decision = 0; decision < MAX_DECISIONS; decision++) {
    if (!current) return refuse('missing')
    const record = current.value
    const issuer = validateIssuer(record.issuer, iss)
    if (!issuer.valid) return refuse('issuer', record.delivery, issuer.error)
    if (record.state === 'claimed') return refuse('in-progress', record.delivery)
    if (record.state === 'finished') return refuse('used', record.delivery)

    const decidedFrom = current
    const sentAt = Date.now()
    let revision: Revision
    try {
      const written = await appState().compareAndSet(
        key,
        decidedFrom.revision,
        { state: 'claimed', issuer: record.issuer, delivery: record.delivery, owner },
        // A claim nobody finishes ends the flow when it lapses.
        { expiry: { ttlMs: MCP_OAUTH_CLAIM_TTL_MS } },
      )
      if (!written.ok) {
        current = written.current
        continue
      }
      revision = written.entry.revision
    } catch (error) {
      // The claim may have landed with its answer lost: what is stored now
      // says whether it is this one.
      let stored: Entry<McpOAuthFlowRecord> | null
      try {
        stored = await appState().get(key)
      } catch {
        console.error('[mcp/oauth] Could not claim the pending flow:', error)
        return refuse('unavailable', record.delivery)
      }
      if (stored?.value.state !== 'claimed' || stored.value.owner !== owner) {
        current = stored
        continue
      }
      revision = stored.revision
    }

    const claim: McpOAuthClaim = {
      key,
      owner,
      revision,
      heldUntil: sentAt + MCP_OAUTH_CLAIM_TTL_MS,
      flow: record,
      flowExpiresAt: decidedFrom.expiresAt,
    }
    if (Date.now() + MCP_OAUTH_EXCHANGE_TIMEOUT_MS + FINISH_MARGIN_MS > claim.heldUntil) {
      await releaseClaim(claim)
      return refuse('late', record.delivery)
    }
    return { claimed: true, claim }
  }
  return refuse('unavailable')
}

/**
 * Gives a claimed flow back, as it was, for another callback. Only for a claim
 * whose code was never sent: once the provider may have seen the code, the
 * flow is finished instead (`finishClaim`).
 */
async function releaseClaim(claim: McpOAuthClaim): Promise<void> {
  try {
    await appState().compareAndSet(
      claim.key,
      claim.revision,
      claim.flow,
      { expiry: claim.flowExpiresAt === null ? 'keep' : { at: claim.flowExpiresAt } },
    )
  } catch (error) {
    // Left to lapse with the claim, after which the flow reads as expired.
    console.warn('[mcp/oauth] Could not give back the claim on a pending flow:', error)
  }
}

/**
 * Marks the claimed flow used: a tombstone without its secrets, kept for the
 * flow's lifetime so a later callback is told the flow was used. The write is
 * conditional on the claim, and only the claim's holder writes a claimed
 * flow, so it fails only when the claim lapsed first (a holder slower than
 * `MCP_OAUTH_CLAIM_TTL_MS`, or a machine asleep mid-exchange).
 *
 * Resolves true when this claim finished the flow, the condition for writing
 * the credentials. A lost answer is settled by reading the flow back: this
 * holder's tombstone means it landed, its claim means it did not.
 */
export async function finishClaim(claim: McpOAuthClaim): Promise<boolean> {
  const finished: McpOAuthFlowRecord = {
    state: 'finished',
    issuer: claim.flow.issuer,
    delivery: claim.flow.delivery,
    owner: claim.owner,
  }
  for (let attempt = 0; attempt < FINISH_ATTEMPTS; attempt++) {
    try {
      return (await appState().compareAndSet(claim.key, claim.revision, finished, { expiry: 'reset' })).ok
    } catch (error) {
      let stored: Entry<McpOAuthFlowRecord> | null
      try {
        stored = await appState().get(claim.key)
      } catch {
        console.error('[mcp/oauth] Could not finish the pending flow:', error)
        return false
      }
      if (stored?.value.state === 'finished' && stored.value.owner === claim.owner) return true
      if (stored?.value.state !== 'claimed' || stored.value.owner !== claim.owner) return false
    }
  }
  console.error('[mcp/oauth] Could not finish the pending flow')
  return false
}

export type McpOAuthErrorResponseValidation =
  | { readonly valid: true; readonly delivery: McpOAuthDelivery }
  | { readonly valid: false; readonly error: string; readonly delivery?: McpOAuthDelivery }

/**
 * Checks an error response (`?error=…`) from the authorization server against
 * the flow, and ends a pending flow it is valid for. One with the wrong issuer
 * leaves the flow as it was. A claimed flow is left to its exchange, and a
 * finished one is over already.
 */
export async function finishAfterErrorResponse(
  state: string,
  iss: string | null | undefined,
): Promise<McpOAuthErrorResponseValidation> {
  const key = mcpOAuthFlowKey(state)
  const owner = randomUUID()
  let current: Entry<McpOAuthFlowRecord> | null
  try {
    current = await appState().get(key)
  } catch (error) {
    console.error('[mcp/oauth] Could not read the pending flow:', error)
    return { valid: false, error: 'Could not read the pending OAuth flow' }
  }
  for (let decision = 0; decision < MAX_DECISIONS; decision++) {
    if (!current) return { valid: false, error: 'No pending OAuth flow for state' }
    const record = current.value
    const issuer = validateIssuer(record.issuer, iss)
    if (!issuer.valid) return { valid: false, error: issuer.error, delivery: record.delivery }
    if (record.state !== 'pending') return { valid: true, delivery: record.delivery }
    try {
      const written = await appState().compareAndSet(
        key,
        current.revision,
        { state: 'finished', issuer: record.issuer, delivery: record.delivery, owner },
        { expiry: 'reset' },
      )
      if (written.ok) return { valid: true, delivery: record.delivery }
      current = written.current
    } catch (error) {
      // The response is the provider's error either way. A flow this left
      // pending expires on its own.
      console.warn('[mcp/oauth] Could not end the pending flow after an error response:', error)
      return { valid: true, delivery: record.delivery }
    }
  }
  return { valid: false, error: 'The pending OAuth flow kept changing' }
}
