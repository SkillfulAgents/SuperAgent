import crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { getDataDir } from '@shared/lib/config/data-dir'
import { flushHostState, hostFileKey, hostStateActive, readScoped, writeScoped } from '@shared/lib/host-state/scope'

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

function tokensFilePath(): string {
  return path.join(getDataDir(), FILE_NAME)
}

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
  if (hostStateActive()) return parseTokens(readScoped(hostFileKey(FILE_NAME)))
  try {
    const raw = fs.readFileSync(tokensFilePath(), 'utf-8')
    return hostTokensSchema.parse(JSON.parse(raw))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[host-token-store] Unreadable token file; regenerating tokens:', error)
    }
    return {}
  }
}

export function getOrCreateHostToken(agentSlug: string): string {
  const tokens = readTokens()
  const existing = tokens[agentSlug]
  if (existing) return existing

  const token = `hostc_${crypto.randomBytes(32).toString('hex')}`
  if (hostStateActive()) {
    // Another request may add a token for this agent first; the save keeps theirs.
    writeScoped(hostFileKey(FILE_NAME), (raw) => {
      const current = parseTokens(raw)
      current[agentSlug] ??= token
      return JSON.stringify(current)
    })
    return readTokens()[agentSlug]
  }
  tokens[agentSlug] = token
  fs.mkdirSync(getDataDir(), { recursive: true })
  fs.writeFileSync(tokensFilePath(), JSON.stringify(tokens, null, 2), { mode: 0o600 })
  return token
}

/** The agent's host token as stored, for a container start: waits for the save so a token made in another request at the same time wins over this one. */
export async function hostTokenForStart(agentSlug: string): Promise<string> {
  getOrCreateHostToken(agentSlug)
  await flushHostState()
  return getOrCreateHostToken(agentSlug)
}
