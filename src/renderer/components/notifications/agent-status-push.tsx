import { useEffect, useMemo, useRef } from 'react'
import { useAgents, type ApiAgent } from '@renderer/hooks/use-agents'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import { applyAgentOrder } from '@renderer/lib/agent-ordering'
import { getActiveTarget } from '@renderer/lib/api-target'
import { isElectron } from '@renderer/lib/env'
import { getAgentActivityStatus } from '@shared/lib/types/agent-activity-status'
import type { AgentStatusEntry, AgentStatusPush as AgentStatusPayload } from '@shared/lib/types/agent-status-push'

type Row = AgentStatusEntry & Pick<ApiAgent, 'createdAt'>

/**
 * What the tray and the Agents menu draw, plus what ordering needs. A `select`,
 * so its result is structurally shared: a list refetch that moves none of
 * these fields re-renders nothing here.
 */
function statusRows(agents: ApiAgent[]): Row[] {
  return agents.map((agent) => ({
    slug: agent.slug,
    name: agent.name,
    createdAt: agent.createdAt,
    activityStatus: getAgentActivityStatus(
      agent.status,
      agent.hasActiveSessions ?? false,
      agent.hasSessionsAwaitingInput ?? false,
    ),
  }))
}

/**
 * Hands Electron main this window's agent list whenever it changes, so the
 * tray and the Agents menu stay current without main polling the API while a
 * window is open. The `['agents']` query is kept current by the notification
 * stream of whichever Superagent this window drives.
 *
 * Nothing is pushed until both the list and the saved order have answered,
 * and the list is withdrawn (`null`) when the query fails or this unmounts:
 * main then asks the API itself. A reload or a crash runs no cleanup; main
 * notices those on its own.
 */
export function useAgentStatusPush(): void {
  const { data: rows, isError } = useAgents({ select: statusRows, poll: false })
  const { data: userSettings, isPending: orderPending } = useUserSettings()

  const agents = useMemo<AgentStatusEntry[] | null>(() => {
    if (!rows || isError || orderPending) return null
    return applyAgentOrder(rows, userSettings?.agentOrder).map(({ slug, name, activityStatus }) => ({ slug, name, activityStatus }))
  }, [rows, isError, orderPending, userSettings?.agentOrder])
  // The effect below runs when what the list says changes, not when it is rebuilt.
  const key = agents ? JSON.stringify(agents) : null
  const latest = useRef(agents)
  latest.current = agents

  const pushed = useRef(false)

  useEffect(() => {
    const list = latest.current
    if (key === null || !list) {
      if (pushed.current) {
        pushed.current = false
        send(null)
      }
      return
    }
    pushed.current = true
    send({ target: getActiveTarget(), agents: list })
  }, [key])

  useEffect(() => () => {
    if (pushed.current) {
      pushed.current = false
      send(null)
    }
  }, [])
}

function send(payload: AgentStatusPayload): void {
  // Main falls back to its own poll when a push does not reach it.
  window.electronAPI?.pushAgentStatus?.(payload)?.catch(() => {})
}

/**
 * Mounted once, in the main window's root layout. Renders nothing, and does
 * nothing outside the desktop app.
 */
export function AgentStatusPush() {
  if (!isElectron() || !window.electronAPI?.pushAgentStatus) return null
  return <AgentStatusPusher />
}

function AgentStatusPusher() {
  useAgentStatusPush()
  return null
}
