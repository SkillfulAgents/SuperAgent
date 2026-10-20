import type { ApiTarget } from '@shared/lib/api-target'
import type { SpotlightAgent, SpotlightSession } from './spotlight-schema'

/**
 * What a Spotlight result opens. It travels as the item's identifier: macOS
 * hands that string back, unchanged, when the result is clicked.
 *
 * Both Superagents are indexed side by side (this computer's and the cloud
 * workspace's), so every reference names the one it belongs to. `workspace`
 * is the result that just switches to it.
 */
export type SpotlightRef =
  | { kind: 'agent'; target: ApiTarget; agentSlug: string }
  | { kind: 'session'; target: ApiTarget; agentSlug: string; sessionId: string }
  | { kind: 'dashboard'; target: ApiTarget; agentSlug: string; dashboardSlug: string }
  | { kind: 'workspace'; target: ApiTarget }

/**
 * Spotlight groups items into domains, and deletes by domain. One per
 * Superagent, so a disconnected cloud workspace is a single delete, plus one
 * for the switch-to results, which exist only while there is a workspace.
 */
export type SpotlightDomain = ApiTarget | 'workspace'

/** One entry, in the shape the native bridge reads. */
export interface SpotlightItem {
  id: string
  domain: SpotlightDomain
  title: string
  subtitle: string
  keywords: string[]
  /**
   * Epoch milliseconds. Orders results: the app's Spotlight scope lists every
   * item before anything is typed, so this is what puts recent work first.
   */
  lastUsedAt: number | null
}

const ID_VERSION = 'v1'

const TARGET_LABEL: Record<ApiTarget, string> = { local: 'Local', cloud: 'Cloud' }

export function encodeSpotlightId(ref: SpotlightRef): string {
  const parts: string[] = [ID_VERSION, ref.kind, ref.target]
  switch (ref.kind) {
    case 'agent':
      parts.push(ref.agentSlug)
      break
    case 'session':
      parts.push(ref.agentSlug, ref.sessionId)
      break
    case 'dashboard':
      parts.push(ref.agentSlug, ref.dashboardSlug)
      break
    case 'workspace':
      break
  }
  return parts.map(encodeURIComponent).join('/')
}

/** The reference behind a clicked result, or null for anything this version did not write. */
export function parseSpotlightId(id: string): SpotlightRef | null {
  let parts: string[]
  try {
    parts = id.split('/').map(decodeURIComponent)
  } catch {
    return null
  }
  const [version, kind, target, ...rest] = parts
  if (version !== ID_VERSION || (target !== 'local' && target !== 'cloud')) return null
  if (rest.some((part) => !part)) return null
  if (kind === 'agent' && rest.length === 1) {
    return { kind, target, agentSlug: rest[0] }
  }
  if (kind === 'session' && rest.length === 2) {
    return { kind, target, agentSlug: rest[0], sessionId: rest[1] }
  }
  if (kind === 'dashboard' && rest.length === 2) {
    return { kind, target, agentSlug: rest[0], dashboardSlug: rest[1] }
  }
  if (kind === 'workspace' && rest.length === 0) {
    return { kind, target }
  }
  return null
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/** Every agent, dashboard and session of one Superagent. */
export function itemsForTarget(
  target: ApiTarget,
  agents: SpotlightAgent[],
  sessionsByAgent: ReadonlyMap<string, SpotlightSession[]>,
): SpotlightItem[] {
  const label = TARGET_LABEL[target]
  const items: SpotlightItem[] = []
  for (const agent of agents) {
    const agentSlug = agent.slug
    const agentLastUsedAt = timestamp(agent.lastActivityAt)
    items.push({
      id: encodeSpotlightId({ kind: 'agent', target, agentSlug }),
      domain: target,
      title: agent.name,
      subtitle: `Agent · ${label}`,
      keywords: ['agent', label],
      lastUsedAt: agentLastUsedAt,
    })
    for (const dashboard of agent.dashboards ?? []) {
      items.push({
        id: encodeSpotlightId({ kind: 'dashboard', target, agentSlug, dashboardSlug: dashboard.slug }),
        domain: target,
        title: dashboard.name,
        subtitle: `Dashboard · ${agent.name} · ${label}`,
        keywords: ['dashboard', agent.name, label],
        lastUsedAt: agentLastUsedAt,
      })
    }
    for (const session of sessionsByAgent.get(agentSlug) ?? []) {
      const title = session.name?.trim()
      if (!title) continue
      items.push({
        id: encodeSpotlightId({ kind: 'session', target, agentSlug, sessionId: session.id }),
        domain: target,
        title,
        subtitle: `Session · ${agent.name} · ${label}`,
        keywords: ['session', agent.name, label],
        lastUsedAt: timestamp(session.lastActivityAt),
      })
    }
  }
  return items
}

/** The two switch-to results, offered while there is a cloud workspace to switch to. */
export function workspaceItems(): SpotlightItem[] {
  return [
    {
      id: encodeSpotlightId({ kind: 'workspace', target: 'local' }),
      domain: 'workspace',
      title: 'This computer',
      subtitle: 'Switch to the agents on this computer',
      keywords: ['workspace', 'switch', TARGET_LABEL.local],
      lastUsedAt: null,
    },
    {
      id: encodeSpotlightId({ kind: 'workspace', target: 'cloud' }),
      domain: 'workspace',
      title: 'Cloud workspace',
      subtitle: 'Switch to your cloud workspace',
      keywords: ['workspace', 'switch', TARGET_LABEL.cloud],
      lastUsedAt: null,
    },
  ]
}

/** What an item looks like to Spotlight, so an unchanged one is not re-sent. */
export function fingerprint(item: SpotlightItem): string {
  return JSON.stringify(item)
}

/** The writes that turn `indexed` (id → fingerprint) into `next`. */
export function diffItems(
  indexed: ReadonlyMap<string, string>,
  next: SpotlightItem[],
): { upsert: SpotlightItem[]; remove: string[] } {
  const nextIds = new Set(next.map((item) => item.id))
  return {
    upsert: next.filter((item) => indexed.get(item.id) !== fingerprint(item)),
    remove: [...indexed.keys()].filter((id) => !nextIds.has(id)),
  }
}
