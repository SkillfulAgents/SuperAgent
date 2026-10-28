import crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { getDataDir } from '@shared/lib/config/data-dir'

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

function readTokens(): HostTokens {
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
  tokens[agentSlug] = token
  fs.mkdirSync(getDataDir(), { recursive: true })
  fs.writeFileSync(tokensFilePath(), JSON.stringify(tokens, null, 2), { mode: 0o600 })
  return token
}
