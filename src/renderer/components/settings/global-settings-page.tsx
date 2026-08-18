import { Suspense, type ReactNode } from 'react'
import { Bolt, Cuboid, Bell, Layers, BarChart3, Blocks, Users, Shield, Route, User, Mic, Activity, Mouse, BadgeCheck, Logs, MousePointer2, Search, Smartphone, Sparkle, Workflow } from 'lucide-react'
import { SettingsPage, type SettingsPageSection, type SettingsPageSectionGroup } from '@renderer/components/settings/settings-page'
import { lazyRouteComponent, type LinkProps } from '@tanstack/react-router'
import { useUser } from '@renderer/context/user-context'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { canUseHostFeatures } from '@renderer/lib/host-features'

// Each settings pane is a separate on-demand boundary. The navigation shell is
// immediately usable, while only the active pane (and its dependency graph) is
// downloaded. TanStack's wrapper adds preload support and one-shot recovery
// from a stale chunk URL after a new deployment.
const ProfileTab = lazyRouteComponent(() => import('./profile-tab'), 'ProfileTab')
const MobileTab = lazyRouteComponent(() => import('./mobile-tab'), 'MobileTab')
const GeneralTab = lazyRouteComponent(() => import('./general-tab'), 'GeneralTab')
const RuntimeTab = lazyRouteComponent(() => import('./runtime-tab'), 'RuntimeTab')
const AccountProviderTab = lazyRouteComponent(() => import('./account-provider-tab'), 'AccountProviderTab')
const NotificationsTab = lazyRouteComponent(() => import('./notifications-tab'), 'NotificationsTab')
const BrowserTab = lazyRouteComponent(() => import('./browser-tab'), 'BrowserTab')
const SkillsetsTab = lazyRouteComponent(() => import('./skillsets-tab'), 'SkillsetsTab')
const UsageTab = lazyRouteComponent(() => import('./usage-tab'), 'UsageTab')
const ConnectionsTab = lazyRouteComponent(() => import('./connections-tab'), 'ConnectionsTab')
const NewIntegrationButton = lazyRouteComponent(
  () => import('@renderer/components/connections/connections-list'),
  'NewIntegrationButton',
)
const LlmTab = lazyRouteComponent(() => import('./llm-tab'), 'LlmTab')
const UsersTab = lazyRouteComponent(() => import('./users-tab'), 'UsersTab')
const AuthTab = lazyRouteComponent(() => import('./auth-tab'), 'AuthTab')
const AdminTab = lazyRouteComponent(() => import('./admin-tab'), 'AdminTab')
const VoiceTab = lazyRouteComponent(() => import('./voice-tab'), 'VoiceTab')
const WebTab = lazyRouteComponent(() => import('./web-tab'), 'WebTab')
const AnalyticsTab = lazyRouteComponent(() => import('./analytics-tab'), 'AnalyticsTab')
const PlatformTab = lazyRouteComponent(() => import('./platform-tab'), 'PlatformTab')
const ComputerUseTab = lazyRouteComponent(() => import('./computer-use-tab'), 'ComputerUseTab')
const CapabilitiesTab = lazyRouteComponent(() => import('./capabilities-tab'), 'CapabilitiesTab')
const AuditLogTab = lazyRouteComponent(() => import('./audit-log-tab'), 'AuditLogTab')

function deferredTab(content: ReactNode): ReactNode {
  return (
    <Suspense
      fallback={(
        <div className="space-y-3 py-2" role="status" aria-label="Loading settings section">
          <div className="h-5 w-40 animate-pulse rounded bg-muted" />
          <div className="h-20 w-full animate-pulse rounded bg-muted/70" />
        </div>
      )}
    >
      {content}
    </Suspense>
  )
}

interface GlobalSettingsPageProps {
  onClose: () => void
  onOpenWizard: () => void
  initialSection?: string
  onSectionChange?: (id: string) => void
  sectionLinkProps?: (id: string) => LinkProps
}

function platformInviteHref(platformBaseUrl: string, orgId: string | null | undefined): string {
  const base = platformBaseUrl.replace(/\/+$/, '')
  // orgId is JWKS-verified and may be null; still send admins somewhere useful.
  return orgId
    ? `${base}/dashboard/organizations/${orgId}?tab=team`
    : `${base}/dashboard`
}

export function GlobalSettingsPage({ onClose, onOpenWizard, initialSection, onSectionChange, sectionLinkProps }: GlobalSettingsPageProps) {
  const { isAuthMode, isAdmin } = useUser()
  const { data: platformAuth } = usePlatformAuthStatus()
  const showAdminSettings = !isAuthMode || isAdmin
  const showAuthAdmin = isAuthMode && isAdmin

  // Same predicate as server isPlatformControlledAuth — not JWKS orgId.
  const hideLocalAuthSections = Boolean(platformAuth?.platformControlled)
  const platformTeamInviteHref =
    hideLocalAuthSections && platformAuth?.platformBaseUrl
      ? platformInviteHref(platformAuth.platformBaseUrl, platformAuth.orgId)
      : undefined

  // Grouped by what the setting concerns (app-level vs agent behavior), not by
  // who can edit it — admin-only sections are filtered per-item instead.
  const appSections: SettingsPageSection[] = [
    ...(isAuthMode ? [{ id: 'profile', label: 'Profile & Login', icon: <User className="h-4 w-4" />, render: () => deferredTab(<ProfileTab />) }] : []),
    // Pairing mints a session credential against THIS deployment's auth, so
    // the tab only exists in auth mode — a local install has no session to pair.
    ...(isAuthMode ? [{ id: 'mobile', label: 'Mobile', icon: <Smartphone className="h-4 w-4" />, render: () => deferredTab(<MobileTab />) }] : []),
    { id: 'general', label: 'General', icon: <Bolt className="h-4 w-4" />, render: () => deferredTab(<GeneralTab onOpenWizard={onOpenWizard} />) },
    { id: 'notifications', label: 'Notifications', icon: <Bell className="h-4 w-4" />, render: () => deferredTab(<NotificationsTab />) },
    { id: 'platform', label: 'Account', icon: <BadgeCheck className="h-4 w-4" />, render: () => deferredTab(<PlatformTab readOnly={isAuthMode} />) },
    ...(isAuthMode && showAdminSettings ? [{ id: 'analytics', label: 'Analytics', icon: <Activity className="h-4 w-4" />, render: () => deferredTab(<AnalyticsTab />) }] : []),
    ...(showAdminSettings ? [{ id: 'admin', label: 'Admin', icon: <Shield className="h-4 w-4" />, render: () => deferredTab(<AdminTab />) }] : []),
    ...(showAuthAdmin
      ? [
          // Keep local role/ban/remove — Platform Team cannot write Better Auth columns.
          // Invite goes to Platform when platform-controlled (local email invite is off).
          {
            id: 'users',
            label: 'Users',
            icon: <Users className="h-4 w-4" />,
            render: () => deferredTab(
              <UsersTab
                platformControlled={hideLocalAuthSections}
                platformInviteHref={platformTeamInviteHref}
              />
            ),
          },
          {
            id: 'auth',
            label: 'Auth',
            icon: <Shield className="h-4 w-4" />,
            render: () => deferredTab(<AuthTab hideLocalAuthSections={hideLocalAuthSections} />),
          },
        ]
      : []),
  ]

  // What agents can do or reach — toggled and curated as needs change.
  const capabilitySections: SettingsPageSection[] = [
    {
      id: 'connections',
      label: 'Connections',
      icon: <Blocks className="h-4 w-4" />,
      render: () => deferredTab(<ConnectionsTab />),
      headerActions: <Suspense fallback={null}><NewIntegrationButton /></Suspense>,
    },
    ...(showAdminSettings
      ? [
          { id: 'skillsets', label: 'Libraries', icon: <Layers className="h-4 w-4" />, render: () => deferredTab(<SkillsetsTab />) },
          { id: 'web', label: 'Web Search', icon: <Search className="h-4 w-4" />, render: () => deferredTab(<WebTab />) },
          { id: 'browser', label: 'Browser Use', icon: <MousePointer2 className="h-4 w-4" />, render: () => deferredTab(<BrowserTab />) },
          // Computer Use drives the machine the agent runs on, and its whole
          // UI — permission grants, the recovery link into System Settings — is
          // written for that machine being yours. `isElectron()` stays true in
          // cloud mode while execution moves to the deployment, so the tab would
          // describe your laptop and govern someone else's.
          ...(canUseHostFeatures() ? [{ id: 'computer-use', label: 'Computer Use', icon: <Mouse className="h-4 w-4" />, render: () => deferredTab(<ComputerUseTab />) }] : []),
          { id: 'capabilities', label: 'Subagents', icon: <Workflow className="h-4 w-4" />, render: () => deferredTab(<CapabilitiesTab />) },
          { id: 'voice', label: 'Voice', icon: <Mic className="h-4 w-4" />, render: () => deferredTab(<VoiceTab />) },
        ]
      : []),
  ]

  // The plumbing agents run on — providers and runtime, mostly set-once.
  const infrastructureSections: SettingsPageSection[] = showAdminSettings
    ? [
        { id: 'llm', label: 'Model Provider', icon: <Sparkle className="h-4 w-4" />, render: () => deferredTab(<LlmTab />) },
        { id: 'account-provider', label: 'Account Provider', icon: <Route className="h-4 w-4" />, render: () => deferredTab(<AccountProviderTab />) },
        { id: 'runtime', label: 'Container Runtime', icon: <Cuboid className="h-4 w-4" />, render: () => deferredTab(<RuntimeTab />) },
      ]
    : []

  // Read-only observability — places you check, not configure.
  const activitySections: SettingsPageSection[] = [
    { id: 'usage', label: 'Usage', icon: <BarChart3 className="h-4 w-4" />, render: () => deferredTab(<UsageTab />) },
    ...(showAdminSettings ? [{ id: 'audit-log', label: 'Audit Log', icon: <Logs className="h-4 w-4" />, render: () => deferredTab(<AuditLogTab />) }] : []),
  ]

  // Empty groups (e.g. Infrastructure for non-admin auth users) would render
  // an orphaned header, so filter them out.
  const groups: SettingsPageSectionGroup[] = [
    { label: 'App Settings', sections: appSections },
    { label: 'Agent Capabilities', sections: capabilitySections },
    { label: 'Agent Infrastructure', sections: infrastructureSections },
    { label: 'Agent Activity', sections: activitySections },
  ].filter((group) => group.sections.length > 0)

  return (
    <SettingsPage
      groups={groups}
      onClose={onClose}
      initialSection={initialSection}
      onSectionChange={onSectionChange}
      sectionLinkProps={sectionLinkProps}
      data-testid="global-settings-page"
      navTestIdPrefix="settings"
    />
  )
}
