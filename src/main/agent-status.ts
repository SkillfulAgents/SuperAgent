// Shared types and utilities for fetching agent status
// Used by the system tray, the application menu and Spotlight

import { z } from 'zod'
import { type AgentActivityStatus, getAgentActivityStatus } from '@shared/lib/types/agent-activity-status'
import type { AgentStatusEntry } from '@shared/lib/types/agent-status-push'
import { SKIP_BOOT_PREFETCH_HEADER } from '@shared/lib/services/cloud-boot-prefetch'
import { applyAgentOrder } from '@shared/lib/utils/agent-order'

// These polls are not made on the renderer's behalf: in cloud mode they travel
// the same proxy paths as the boot prefetches, which are one-shot and reserved
// for the reloading renderer. Marked out so a poll racing a switch cannot
// consume the renderer's head start.
export const POLL_HEADERS = { [SKIP_BOOT_PREFETCH_HEADER]: '1' }

export type ActivityStatus = AgentActivityStatus

export type AgentInfo = AgentStatusEntry

/**
 * A request that never answers must not hold the poll: the task manager skips
 * a pass that comes due while the last one is still running.
 */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * The slice of an `/api/agents` row the tray and the Agents menu read. The
 * list already says whether an agent has sessions working or waiting on the
 * user, so nothing asks for its sessions. The cloud workspace can run another
 * version than this app, so everything beyond identity is optional.
 */
const listedAgentSchema = z.object({
  slug: z.string().min(1),
  name: z.string(),
  // An unknown status reads as running: only `stopped` is drawn differently.
  status: z.enum(['stopped', 'running']).catch('running'),
  createdAt: z.string().catch(''),
  hasActiveSessions: z.boolean().optional().catch(undefined),
  hasSessionsAwaitingInput: z.boolean().optional().catch(undefined),
})

const userSettingsSchema = z.object({ agentOrder: z.array(z.string()).optional().catch(undefined) })

/**
 * Fetch agents with their activity status from the API,
 * sorted by the user's saved agent order.
 *
 * `apiBaseUrl` is the *effective* base — in cloud mode it is the keyed proxy
 * prefix, so the tray and app menu list the same Superagent the renderers are
 * driving rather than always this machine's.
 *
 * Two requests, whatever the number of agents.
 */
export async function fetchAgentsWithStatus(
  apiBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentInfo[]> {
  try {
    const get = (path: string) =>
      fetchImpl(`${apiBaseUrl}${path}`, { headers: POLL_HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    // Fetch agents and user settings in parallel
    const [agentsRes, settingsRes] = await Promise.all([
      get('/api/agents'),
      get('/api/user-settings').catch(() => null),
    ])
    if (!agentsRes.ok) return []
    // One malformed row is dropped rather than emptying both menus.
    const agents = z.array(z.unknown()).parse(await agentsRes.json()).flatMap((row) => {
      const parsed = listedAgentSchema.safeParse(row)
      return parsed.success ? [parsed.data] : []
    })

    let agentOrder: string[] | undefined
    if (settingsRes?.ok) {
      const settings = userSettingsSchema.safeParse(await settingsRes.json().catch(() => null))
      agentOrder = settings.success ? settings.data.agentOrder : undefined
    }

    return applyAgentOrder(agents, agentOrder).map((agent) => ({
      slug: agent.slug,
      name: agent.name,
      activityStatus: getAgentActivityStatus(
        agent.status,
        agent.hasActiveSessions ?? false,
        agent.hasSessionsAwaitingInput ?? false,
      ),
    }))
  } catch (error) {
    console.error('Failed to fetch agents:', error)
    return []
  }
}
