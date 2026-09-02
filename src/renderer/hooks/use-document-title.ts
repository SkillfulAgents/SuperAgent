import { useEffect, useMemo, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { useAgent } from '@renderer/hooks/use-agents'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useSession } from '@renderer/hooks/use-sessions'
import { useRouteLocation } from '@renderer/router/use-route-location'
import { settingsTabSchema, type SettingsTab } from '@renderer/router/search-schemas'
import type { AppLocation, AgentView } from '@renderer/router/route-state'

const APP_TITLE = 'Gamut'
const BRAND_SEPARATOR = ' \u00b7 '
const VIEW_SEPARATOR = ' \u2014 '

// Tab-title status indicator, shown only while the tab is hidden so a user
// with many tabs open can read session state off the tab strip. Geometric
// shapes rather than emoji: they render monochrome and single-width in every
// browser's tab strip, and none has an emoji presentation Chrome would
// colorize. Priority mirrors the sidebar session row (app-sidebar.tsx):
// awaiting > working > unread.
const AWAITING_FRAMES = ['\u25c6', '\u25c7'] // ◆ ◇ — blink
const WORKING_FRAMES = ['\u25d0', '\u25d1'] // ◐ ◑ — spin
const UNREAD_GLYPH = '\u25cf' // ●
// Browsers clamp timers in hidden tabs to once per second (and to once per
// minute after ~5 min), so anything faster would be silently throttled.
export const TITLE_INDICATOR_FRAME_MS = 1000

export interface TitleIndicatorFlags {
  isActive?: boolean
  isAwaitingInput?: boolean
  hasUnreadNotifications?: boolean
  /** Session-view stream state; the `session_active` echo can lag stream start by a tick. */
  isStreaming?: boolean
}

/** Whether the indicator for these flags cycles frames (needs a timer). */
export function isTitleIndicatorAnimated(flags: TitleIndicatorFlags): boolean {
  return !!(flags.isAwaitingInput || flags.isActive || flags.isStreaming)
}

export function getTitleIndicator(flags: TitleIndicatorFlags, frame: number): string | null {
  const step = Math.abs(frame) % 2
  if (flags.isAwaitingInput) return AWAITING_FRAMES[step]
  if (flags.isActive || flags.isStreaming) return WORKING_FRAMES[step]
  if (flags.hasUnreadNotifications) return UNREAD_GLYPH
  return null
}

export function applyTitleIndicator(title: string, indicator: string | null): string {
  return indicator ? `${indicator} ${title}` : title
}

const SETTINGS_TAB_TITLES = {
  profile: 'Profile & Login',
  mobile: 'Mobile',
  general: 'General',
  notifications: 'Notifications',
  platform: 'Account',
  connections: 'Connections',
  usage: 'Usage',
  llm: 'Model Provider',
  runtime: 'Container Runtime',
  browser: 'Browser Use',
  web: 'Web Search',
  capabilities: 'Subagents',
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
    case 'inboundXAgent':
      return joinView(agentTitle, 'Called from Other Agents')
    case 'completedTasks':
      return joinView(agentTitle, 'Completed One-time Tasks')
    case 'chat':
      return joinView(agentTitle, 'Remote Chat')
    case 'dashboard':
      return joinView(agentTitle, cleanTitlePart(input.dashboardName) ?? humanizeIdentifier(view.slug) ?? 'Dashboard')
    case 'apiLogs':
      return joinView(agentTitle, 'API Logs')
    case 'secrets':
      return joinView(agentTitle, 'Secrets')
    case 'xAgentPermissions':
      return joinView(agentTitle, 'Agent-to-agent Connections')
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

function useTabHidden(): boolean {
  const [hidden, setHidden] = useState(
    () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  )
  useEffect(() => {
    const onVisibilityChange = () => setHidden(document.visibilityState === 'hidden')
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])
  return hidden
}

/**
 * Indicator glyph for the session on screen, or null when the tab is visible
 * or the session has nothing to report. The frame timer only runs while the
 * tab is hidden AND the state animates, so a visible tab or an idle session
 * costs nothing.
 */
function useHiddenTabIndicator(flags: TitleIndicatorFlags | null): string | null {
  const hidden = useTabHidden()
  const animated = hidden && flags !== null && isTitleIndicatorAnimated(flags)
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!animated) return
    setFrame(0)
    const timer = setInterval(() => setFrame((f) => f + 1), TITLE_INDICATOR_FRAME_MS)
    return () => clearInterval(timer)
  }, [animated])

  if (!hidden || flags === null) return null
  return getTitleIndicator(flags, frame)
}

export function useDocumentTitle() {
  const location = useRouteLocation()
  const settings = useSettingsTitleState()
  const agentSlug = location.selectedAgentSlug
  const sessionId = location.view.kind === 'session' ? location.view.id : null

  const { data: agent } = useAgent(agentSlug)
  const { data: session } = useSession(sessionId, agentSlug)
  const { isStreaming } = useMessageStream(sessionId, agentSlug)

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

  const indicatorFlags = useMemo<TitleIndicatorFlags | null>(
    () =>
      sessionId && session
        ? {
            isActive: session.isActive,
            isAwaitingInput: session.isAwaitingInput,
            hasUnreadNotifications: session.hasUnreadNotifications,
            isStreaming,
          }
        : null,
    [isStreaming, session, sessionId],
  )
  const indicator = useHiddenTabIndicator(indicatorFlags)

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.title = applyTitleIndicator(title, indicator)
  }, [indicator, title])
}
