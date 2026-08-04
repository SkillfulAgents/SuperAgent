import { Bolt, Cuboid, Bell, Layers, BarChart3, Blocks, Users, Shield, Route, User, Mic, Activity, Mouse, BadgeCheck, Logs, MousePointer2, Search, Sparkle, Workflow } from 'lucide-react'
import { SettingsPage, type SettingsPageSection, type SettingsPageSectionGroup } from '@renderer/components/settings/settings-page'
import { type LinkProps } from '@tanstack/react-router'
import { ProfileTab } from './profile-tab'
import { GeneralTab } from './general-tab'
import { RuntimeTab } from './runtime-tab'
import { AccountProviderTab } from './account-provider-tab'
import { NotificationsTab } from './notifications-tab'
import { BrowserTab } from './browser-tab'
import { SkillsetsTab } from './skillsets-tab'
import { UsageTab } from './usage-tab'
import { ConnectionsTab } from './connections-tab'
import { NewIntegrationButton } from '@renderer/components/connections/connections-list'
import { LlmTab } from './llm-tab'
import { UsersTab } from './users-tab'
import { AuthTab } from './auth-tab'
import { AdminTab } from './admin-tab'
import { VoiceTab } from './voice-tab'
import { WebTab } from './web-tab'
import { AnalyticsTab } from './analytics-tab'
import { PlatformTab } from './platform-tab'
import { ComputerUseTab } from './computer-use-tab'
import { CapabilitiesTab } from './capabilities-tab'
import { AuditLogTab } from './audit-log-tab'
import { useUser } from '@renderer/context/user-context'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { canUseHostFeatures } from '@renderer/lib/host-features'

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
    ...(isAuthMode ? [{ id: 'profile', label: 'Profile & Login', icon: <User className="h-4 w-4" />, render: () => <ProfileTab /> }] : []),
    { id: 'general', label: 'General', icon: <Bolt className="h-4 w-4" />, render: () => <GeneralTab onOpenWizard={onOpenWizard} /> },
    { id: 'notifications', label: 'Notifications', icon: <Bell className="h-4 w-4" />, render: () => <NotificationsTab /> },
    { id: 'platform', label: 'Account', icon: <BadgeCheck className="h-4 w-4" />, render: () => <PlatformTab readOnly={isAuthMode} /> },
    ...(isAuthMode && showAdminSettings ? [{ id: 'analytics', label: 'Analytics', icon: <Activity className="h-4 w-4" />, render: () => <AnalyticsTab /> }] : []),
    ...(showAdminSettings ? [{ id: 'admin', label: 'Admin', icon: <Shield className="h-4 w-4" />, render: () => <AdminTab /> }] : []),
    ...(showAuthAdmin
      ? [
          // Keep local role/ban/remove — Platform Team cannot write Better Auth columns.
          // Invite goes to Platform when platform-controlled (local email invite is off).
          {
            id: 'users',
            label: 'Users',
            icon: <Users className="h-4 w-4" />,
            render: () => <UsersTab platformInviteHref={platformTeamInviteHref} />,
          },
          {
            id: 'auth',
            label: 'Auth',
            icon: <Shield className="h-4 w-4" />,
            render: () => <AuthTab hideLocalAuthSections={hideLocalAuthSections} />,
          },
        ]
      : []),
  ]

  // What agents can do or reach — toggled and curated as needs change.
  const capabilitySections: SettingsPageSection[] = [
    { id: 'connections', label: 'Connections', icon: <Blocks className="h-4 w-4" />, render: () => <ConnectionsTab />, headerActions: <NewIntegrationButton /> },
    ...(showAdminSettings
      ? [
          { id: 'skillsets', label: 'Skillsets', icon: <Layers className="h-4 w-4" />, render: () => <SkillsetsTab /> },
          { id: 'web', label: 'Web Search', icon: <Search className="h-4 w-4" />, render: () => <WebTab /> },
          { id: 'browser', label: 'Browser Use', icon: <MousePointer2 className="h-4 w-4" />, render: () => <BrowserTab /> },
          // Computer Use drives the machine the agent runs on, and its whole
          // UI — permission grants, the recovery link into System Settings — is
          // written for that machine being yours. `isElectron()` stays true in
          // cloud mode while execution moves to the deployment, so the tab would
          // describe your laptop and govern someone else's.
          ...(canUseHostFeatures() ? [{ id: 'computer-use', label: 'Computer Use', icon: <Mouse className="h-4 w-4" />, render: () => <ComputerUseTab /> }] : []),
          { id: 'capabilities', label: 'Subagents', icon: <Workflow className="h-4 w-4" />, render: () => <CapabilitiesTab /> },
          { id: 'voice', label: 'Voice', icon: <Mic className="h-4 w-4" />, render: () => <VoiceTab /> },
        ]
      : []),
  ]

  // The plumbing agents run on — providers and runtime, mostly set-once.
  const infrastructureSections: SettingsPageSection[] = showAdminSettings
    ? [
        { id: 'llm', label: 'Model Provider', icon: <Sparkle className="h-4 w-4" />, render: () => <LlmTab /> },
        { id: 'account-provider', label: 'Account Provider', icon: <Route className="h-4 w-4" />, render: () => <AccountProviderTab /> },
        { id: 'runtime', label: 'Container Runtime', icon: <Cuboid className="h-4 w-4" />, render: () => <RuntimeTab /> },
      ]
    : []

  // Read-only observability — places you check, not configure.
  const activitySections: SettingsPageSection[] = [
    { id: 'usage', label: 'Usage', icon: <BarChart3 className="h-4 w-4" />, render: () => <UsageTab /> },
    ...(showAdminSettings ? [{ id: 'audit-log', label: 'Audit Log', icon: <Logs className="h-4 w-4" />, render: () => <AuditLogTab /> }] : []),
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
