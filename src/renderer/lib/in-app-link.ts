import { settingsTabSchema, type SettingsTab } from '@renderer/router/search-schemas'

const SETTINGS_LINK = /^\/settings\/([\w-]+)$/
const AGENT_LINK = /^\/agents\/[\w-]+(?:\/([\w-]+)(?:\/([\w-]+))?)?$/

/** Agent sub-pages an in-app link may open; `/agents/<slug>` alone opens the agent home. */
export const AGENT_PAGES = ['secrets', 'memories', 'connections', 'api-logs', 'x-agent-permissions'] as const

/** Agent pages for one item, linked as `/agents/<slug>/<page>/<id>`. */
export const AGENT_ITEM_PAGES = ['dashboards', 'tasks'] as const

/** The Settings tab an in-app link like `/settings/llm` points at, or null for any other href. */
export function settingsTabFromHref(href: string | undefined): SettingsTab | null {
  const tab = href?.match(SETTINGS_LINK)?.[1]
  return settingsTabSchema.safeParse(tab).data ?? null
}

/** True for an exact agent home, AGENT_PAGES, or AGENT_ITEM_PAGES link. */
export function isAgentPageHref(href: string | undefined): href is string {
  const match = href?.match(AGENT_LINK)
  if (!match) return false
  const [, page, id] = match
  if (page === undefined) return true
  return ((id ? AGENT_ITEM_PAGES : AGENT_PAGES) as readonly string[]).includes(page)
}
