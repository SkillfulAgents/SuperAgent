import { Suspense, type ReactNode } from 'react'
import { AnimatedNavIcon } from '@renderer/components/ui/animated-nav-icon'
import { SettingsPage, type SettingsPageSection, type SettingsPageSectionGroup } from '@renderer/components/settings/settings-page'
import { lazyRouteComponent, type LinkProps } from '@tanstack/react-router'
import { useUser } from '@renderer/context/user-context'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { offersComputerUseSettings } from '@renderer/lib/capabilities'

// Each settings pane is a separate on-demand boundary. The navigation shell is
// immediately usable, while only the active pane (and its dependency graph) is
// downloaded. TanStack's wrapper adds preload support and one-shot recovery
// from a stale chunk URL after a new deployment.
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
const GlobalInstructionsTab = lazyRouteComponent(() => import('./global-instructions-tab'), 'GlobalInstructionsTab')
const AuditLogTab = lazyRouteComponent(() => import('./audit-log-tab'), 'AuditLogTab')
const ExperimentsTab = lazyRouteComponent(() => import('./experiments-tab'), 'ExperimentsTab')
const VolumesTab = lazyRouteComponent(() => import('./volumes-tab'), 'VolumesTab')
const LoginsTab = lazyRouteComponent(() => import('./logins-tab'), 'LoginsTab')

function deferredTab(content: ReactNode): ReactNode {
  return (
    <Suspense
      fallback={(
        <div className="space-y-3 py-2" role="status" aria-label="Loading settings section">
          <div className="h-5 w-40 animate-pulse rounded bg-muted" />
          <div className="h-20 w-full animate-pulse rounded-card bg-muted/70" />
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
  // General always leads and Admin always trails; the mode-gated items sit
  // between those two anchors in every mode.
  const appSections: SettingsPageSection[] = [
    { id: 'general', label: 'General', icon: <AnimatedNavIcon name="general" className="h-4 w-4" />, render: () => deferredTab(<GeneralTab onOpenWizard={onOpenWizard} />) },
    { id: 'notifications', label: 'Notifications', icon: <AnimatedNavIcon name="bell" className="h-4 w-4" />, render: () => deferredTab(<NotificationsTab />) },
    { id: 'platform', label: 'Account', icon: <AnimatedNavIcon name="account" className="h-4 w-4" />, render: () => deferredTab(<PlatformTab readOnly={isAuthMode} />) },
    // Everyone: each switch is the viewer's own.
    { id: 'experiments', label: 'Experiments', icon: <AnimatedNavIcon name="experiments" className="h-4 w-4" />, render: () => deferredTab(<ExperimentsTab />) },
    ...(isAuthMode && showAdminSettings ? [{ id: 'analytics', label: 'Analytics', icon: <AnimatedNavIcon name="analytics" className="h-4 w-4" />, render: () => deferredTab(<AnalyticsTab />) }] : []),
    ...(showAuthAdmin
      ? [
          // Keep local role/ban/remove — Platform Team cannot write Better Auth columns.
          // Invite goes to Platform when platform-controlled (local email invite is off).
          {
            id: 'users',
            label: 'Users',
            icon: <AnimatedNavIcon name="users" className="h-4 w-4" />,
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
            icon: <AnimatedNavIcon name="shield" className="h-4 w-4" />,
            render: () => deferredTab(<AuthTab hideLocalAuthSections={hideLocalAuthSections} />),
          },
        ]
      : []),
    ...(showAdminSettings ? [{ id: 'admin', label: 'Admin', icon: <AnimatedNavIcon name="shield" className="h-4 w-4" />, render: () => deferredTab(<AdminTab />) }] : []),
  ]

  // What agents can do or reach — toggled and curated as needs change.
  const capabilitySections: SettingsPageSection[] = [
    // Pairing mints a session credential against THIS deployment's auth, so
    // the tab only exists in auth mode — a local install has no session to pair.
    ...(isAuthMode ? [{ id: 'mobile', label: 'Mobile', icon: <AnimatedNavIcon name="mobile" className="h-4 w-4" />, render: () => deferredTab(<MobileTab />) }] : []),
    {
      id: 'connections',
      label: 'Connections',
      icon: <AnimatedNavIcon name="connections" className="h-4 w-4" />,
      render: () => deferredTab(<ConnectionsTab />),
      headerActions: <Suspense fallback={null}><NewIntegrationButton /></Suspense>,
    },
    { id: 'volumes', label: 'Drives', icon: <AnimatedNavIcon name="folder" className="h-4 w-4" />, render: () => deferredTab(<VolumesTab />) },
    // Everyone: each user's vault is their own.
    { id: 'logins', label: 'Logins', icon: <AnimatedNavIcon name="key" className="h-4 w-4" />, render: () => deferredTab(<LoginsTab />) },
    ...(showAdminSettings
      ? [
          { id: 'skillsets', label: 'Skillsets', icon: <AnimatedNavIcon name="layers" className="h-4 w-4" />, render: () => deferredTab(<SkillsetsTab />) },
          { id: 'web', label: 'Web Search', icon: <AnimatedNavIcon name="search" className="h-4 w-4" />, render: () => deferredTab(<WebTab />) },
          { id: 'browser', label: 'Browser Use', icon: <AnimatedNavIcon name="pointer" className="h-4 w-4" />, render: () => deferredTab(<BrowserTab />) },
          // Computer Use drives the machine the agent runs on, and its whole
          // UI — permission grants, the recovery link into System Settings — is
          // written for that machine being yours. `isElectron()` stays true in
          // cloud mode while execution moves to the deployment, so the tab would
          // describe your laptop and govern someone else's. A sandboxed build
          // has no computer use to govern.
          ...(offersComputerUseSettings() ? [{ id: 'computer-use', label: 'Computer Use', icon: <AnimatedNavIcon name="mouse" className="h-4 w-4" />, render: () => deferredTab(<ComputerUseTab />) }] : []),
          { id: 'capabilities', label: 'Subagents', icon: <AnimatedNavIcon name="workflow" className="h-4 w-4" />, render: () => deferredTab(<CapabilitiesTab />) },
        ]
      : []),
    // Everyone: what every agent is told is visible to all; the editor is
    // read-only for non-admins.
    { id: 'global-guidance', label: 'Global Guidance', icon: <AnimatedNavIcon name="guidance" className="h-4 w-4" />, render: () => deferredTab(<GlobalInstructionsTab />) },
    // Everyone: the tab carries each person's own read-aloud voice; the
    // provider and key sections inside it are admin-gated.
    { id: 'llm', label: 'Model Providers', icon: <AnimatedNavIcon name="sparkle" className="h-4 w-4" />, render: () => deferredTab(<LlmTab />) },
    { id: 'voice', label: 'Voice', icon: <AnimatedNavIcon name="mic" className="h-4 w-4" />, render: () => deferredTab(<VoiceTab />) },
  ]

  // The plumbing agents run on — providers and runtime, mostly set-once.
  const infrastructureSections: SettingsPageSection[] = showAdminSettings
    ? [

        { id: 'account-provider', label: 'Account Provider', icon: <AnimatedNavIcon name="route" className="h-4 w-4" />, render: () => deferredTab(<AccountProviderTab />) },
        { id: 'runtime', label: 'Container Runtime', icon: <AnimatedNavIcon name="runtime" className="h-4 w-4" />, render: () => deferredTab(<RuntimeTab />) },
      ]
    : []

  // Read-only observability — places you check, not configure.
  const activitySections: SettingsPageSection[] = [
    { id: 'usage', label: 'Usage', icon: <AnimatedNavIcon name="usage" className="h-4 w-4" />, render: () => deferredTab(<UsageTab />) },
    ...(showAdminSettings ? [{ id: 'audit-log', label: 'Audit Log', icon: <AnimatedNavIcon name="logs" className="h-4 w-4" />, render: () => deferredTab(<AuditLogTab />) }] : []),
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
