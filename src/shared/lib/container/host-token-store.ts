import crypto from 'crypto'
import { getOrCreateRecord, type RecordDb } from '@shared/lib/app-records/records'
import { hostContainerTokenKey, hostContainerTokenRecordSchema } from '@shared/lib/app-records/record-schemas'

/**
 * Per-agent secrets that authenticate the HOST to the agent's container API
 * (the reverse of PROXY_TOKEN, which authenticates the container/agent to the
 * host and is deliberately agent-visible). The container refuses policy-bearing
 * requests — session creation, sends carrying capabilityPolicies, input
 * resolve/reject — without this token, so an agent can't loosen its own launch
 * policy or self-approve a parked review through the in-container API.
 *
 * Kept as one app record per agent (never mounted into containers). Must
 * survive host restarts: containers outlive the host process and keep
 * requiring the token they were started with. Each agent's token is created
 * with insert-if-absent, so concurrent first uses agree on one token and
 * creating one agent's token never touches another's.
 */
export async function getOrCreateHostToken(
  agentSlug: string,
  db?: RecordDb,
): Promise<string> {
  return getOrCreateRecord(hostContainerTokenKey(agentSlug), hostContainerTokenRecordSchema, () =>
    `hostc_${crypto.randomBytes(32).toString('hex')}`, db)
}
