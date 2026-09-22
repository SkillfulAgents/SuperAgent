import type { QueryClient } from '@tanstack/react-query'
import { apiFetch } from './api'
import {
  MAX_AGENT_MEMBERS_BATCH_SIZE,
  agentMembersBatchResponseSchema,
  type AgentMember,
} from '@shared/lib/agent-members-schema'

type PendingRoster = {
  agentSlug: string
  signal: AbortSignal
  resolve: (members: AgentMember[]) => void
  reject: (error: unknown) => void
}

async function fetchBatch(requests: PendingRoster[]) {
  const controller = new AbortController()
  const abortIfUnused = () => {
    if (requests.every(request => request.signal.aborted)) controller.abort()
  }
  for (const request of requests) request.signal.addEventListener('abort', abortIfUnused)
  try {
    const response = await apiFetch('/api/agents/members/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentSlugs: requests.map(request => request.agentSlug) }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('Could not load members')
    const results = agentMembersBatchResponseSchema.parse(await response.json())
    for (const request of requests) {
      if (request.signal.aborted) continue
      const result = results[request.agentSlug]
      if (result?.status === 200) request.resolve(result.members)
      else request.reject(new Error(`Could not load members (${result?.status ?? 'missing result'})`))
    }
  } catch (error) {
    for (const request of requests) request.reject(error)
  } finally {
    for (const request of requests) request.signal.removeEventListener('abort', abortIfUnused)
  }
}

function createLoader() {
  let pending: PendingRoster[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  return (agentSlug: string, signal: AbortSignal): Promise<AgentMember[]> => new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    pending.push({
      agentSlug,
      signal,
      resolve: members => {
        signal.removeEventListener('abort', onAbort)
        resolve(members)
      },
      reject: error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    })
    // Collect the queries started by one render or cache invalidation together.
    timer ??= setTimeout(() => {
      const requests = pending.filter(request => !request.signal.aborted)
      pending = []
      timer = undefined
      for (let start = 0; start < requests.length; start += MAX_AGENT_MEMBERS_BATCH_SIZE) {
        void fetchBatch(requests.slice(start, start + MAX_AGENT_MEMBERS_BATCH_SIZE))
      }
    }, 0)
  })
}

// Scope pending work to the cache. Query cancellation on sign-out/revocation
// rejects just that roster; the shared fetch stops when all callers cancel.
const loaders = new WeakMap<QueryClient, ReturnType<typeof createLoader>>()
export function loadAgentMembers(client: QueryClient, agentSlug: string, signal: AbortSignal) {
  let loader = loaders.get(client)
  if (!loader) {
    loader = createLoader()
    loaders.set(client, loader)
  }
  return loader(agentSlug, signal)
}
