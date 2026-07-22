import { useEffect, useMemo } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { useAgent } from '@renderer/hooks/use-agents'
import { useSession } from '@renderer/hooks/use-sessions'
import { useRouteLocation } from '@renderer/router/use-route-location'
import { settingsTabSchema, type SettingsTab } from '@renderer/router/search-schemas'
import type { AppLocation, AgentView } from '@renderer/router/route-state'

const APP_TITLE = 'Gamut'
const BRAND_SEPARATOR = ' \u00b7 '
const VIEW_SEPARATOR = ' \u2014 '

const SETTINGS_TAB_TITLES = {
  profile: 'Profile & Login',
  general: 'General',
  notifications: 'Notifications',
  platform: 'Account',
  connections: 'Connections',
  usage: 'Usage',
  llm: 'LLM Provider',
  runtime: 'Runtime',
  browser: 'Browser Use',
  web: 'Web',
  capabilities: 'Agent Capabilities',
  'computer-use': 'Computer Use',
  'account-provider': 'Account Provider',
  voice: 'Voice',
  skillsets: 'Skillsets',
  analytics: 'Analytics',
  'audit-log': 'Audit Log',
  admin: 'Admin',
  users: 'Users',
  auth: 'Auth',
} satisfies Record<SettingsTab, string>

interface SettingsTitleState {
  isSettingsRoute: boolean
  tab: string | null
}

export interface DocumentTitleInput {
  location: AppLocation
  isSettingsRoute?: boolean
  settingsTab?: string | null
  agentName?: string | null
  agentSlug?: string | null
  sessionName?: string | null
  dashboardName?: string | null
}

function cleanTitlePart(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function humanizeIdentifier(value: string | null | undefined): string | null {
  const cleaned = cleanTitlePart(value)
  if (!cleaned) return null
  return cleaned
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function formatSettingsTabTitle(tab: string | null | undefined): string | null {
  const parsed = settingsTabSchema.safeParse(tab)
  if (!parsed.success) return null
  return SETTINGS_TAB_TITLES[parsed.data]
}

function formatAgentTitlePart(agentName: string | null | undefined, agentSlug: string | null | undefined): string {
  return cleanTitlePart(agentName) ?? cleanTitlePart(agentSlug) ?? APP_TITLE
}

function joinWithBrand(title: string): string {
  return `${title}${BRAND_SEPARATOR}${APP_TITLE}`
}

function joinView(agentTitle: string, viewTitle: string): string {
  return `${agentTitle}${VIEW_SEPARATOR}${viewTitle}`
}

function assertNever(value: never): never {
  throw new Error(`Unhandled AgentView kind: ${JSON.stringify(value)}`)
}

function titleForAgentView(view: AgentView, input: DocumentTitleInput): string {
  const agentTitle = formatAgentTitlePart(input.agentName, input.agentSlug ?? input.location.selectedAgentSlug)

  switch (view.kind) {
    case 'home':
      return input.location.selectedAgentSlug ? joinWithBrand(agentTitle) : APP_TITLE
    case 'session':
      return `${cleanTitlePart(input.sessionName) ?? 'Session'}${VIEW_SEPARATOR}${agentTitle}`
    case 'task':
      return joinView(agentTitle, 'Scheduled Task')
    case 'webhook':
      return joinView(agentTitle, 'Webhook Trigger')
    case 'chat':
      return joinView(agentTitle, 'Remote Chat')
    case 'dashboard':
      return joinView(agentTitle, cleanTitlePart(input.dashboardName) ?? humanizeIdentifier(view.slug) ?? 'Dashboard')
    case 'apiLogs':
      return joinView(agentTitle, 'API Logs')
    case 'secrets':
      return joinView(agentTitle, 'Secrets')
    case 'connections':
      return joinView(agentTitle, view.detail?.view === 'logs' ? 'Connection Logs' : 'Connections')
    case 'notifications':
      return joinWithBrand('Notifications')
    default:
      return assertNever(view)
  }
}

export function getDocumentTitle(input: DocumentTitleInput): string {
  if (input.isSettingsRoute) {
    const tabTitle = formatSettingsTabTitle(input.settingsTab)
    return tabTitle ? `Settings${VIEW_SEPARATOR}${tabTitle}` : joinWithBrand('Settings')
  }

  return titleForAgentView(input.location.view, input)
}

function useSettingsTitleState(): SettingsTitleState {
  return useRouterState({
    structuralSharing: true,
    select: (state): SettingsTitleState => {
      const params: Record<string, string | undefined> = {}
      for (const match of state.matches) {
        Object.assign(params, match.params)
      }

      const deepest = state.matches[state.matches.length - 1]
      const fullPath = deepest?.fullPath ?? ''
      const normalizedPath = fullPath.length > 1 && fullPath.endsWith('/') ? fullPath.slice(0, -1) : fullPath
      const isSettingsRoute = normalizedPath === '/settings' || normalizedPath === '/settings/$tab'

      return {
        isSettingsRoute,
        tab: typeof params.tab === 'string' ? params.tab : null,
      }
    },
  })
}

export function useDocumentTitle() {
  const location = useRouteLocation()
  const settings = useSettingsTitleState()
  const agentSlug = location.selectedAgentSlug
  const sessionId = location.view.kind === 'session' ? location.view.id : null

  const { data: agent } = useAgent(agentSlug)
  const { data: session } = useSession(sessionId, agentSlug)

  const dashboardName = useMemo(() => {
    if (location.view.kind !== 'dashboard') return null
    const dashboardSlug = location.view.slug
    return agent?.dashboards?.find((dashboard) => dashboard.slug === dashboardSlug)?.name ?? null
  }, [agent, location.view])

  const title = useMemo(
    () =>
      getDocumentTitle({
        location,
        isSettingsRoute: settings.isSettingsRoute,
        settingsTab: settings.tab,
        agentName: agent?.name,
        agentSlug,
        sessionName: session?.name,
        dashboardName,
      }),
    [agent?.name, agentSlug, dashboardName, location, session?.name, settings.isSettingsRoute, settings.tab],
  )

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.title = title
  }, [title])
}
