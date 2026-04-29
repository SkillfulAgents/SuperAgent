import { Settings, Link2, Container, Bell, Globe, Library, BarChart3, Plug, Brain, Users, Shield, ShieldEllipsis, User, Mic, Activity, Terminal, Waypoints } from 'lucide-react'
import { SettingsPage, type SettingsPageSection, type SettingsPageSectionGroup } from '@renderer/components/settings/settings-page'
import { ProfileTab } from './profile-tab'
import { GeneralTab } from './general-tab'
import { RuntimeTab } from './runtime-tab'
import { ComposioTab } from './composio-tab'
import { NotificationsTab } from './notifications-tab'
import { BrowserTab } from './browser-tab'
import { SkillsetsTab } from './skillsets-tab'
import { UsageTab } from './usage-tab'
import { RemoteMcpsTab } from './remote-mcps-tab'
import { LlmTab } from './llm-tab'
import { AccountsTab } from './accounts-tab'
import { UsersTab } from './users-tab'
import { AuthTab } from './auth-tab'
import { AdminTab } from './admin-tab'
import { VoiceTab } from './voice-tab'
import { AnalyticsTab } from './analytics-tab'
import { PlatformTab } from './platform-tab'
import { ComputerUseTab } from './computer-use-tab'
import { useUser } from '@renderer/context/user-context'
import { isElectron } from '@renderer/lib/env'

interface GlobalSettingsPageProps {
  onClose: () => void
  onOpenWizard: () => void
  initialSection?: string
}

export function GlobalSettingsPage({ onClose, onOpenWizard, initialSection }: GlobalSettingsPageProps) {
  const { isAuthMode, isAdmin } = useUser()
  const showAdminSettings = !isAuthMode || isAdmin
  const showAuthAdmin = isAuthMode && isAdmin
  const showSectionHeaders = isAuthMode && isAdmin

  const userSections: SettingsPageSection[] = [
    ...(isAuthMode ? [{ id: 'profile', label: 'Profile & Login', icon: <User className="h-4 w-4" />, render: () => <ProfileTab /> }] : []),
    { id: 'general', label: 'General', icon: <Settings className="h-4 w-4" />, render: () => <GeneralTab onOpenWizard={onOpenWizard} /> },
    { id: 'notifications', label: 'Notifications', icon: <Bell className="h-4 w-4" />, render: () => <NotificationsTab /> },
    { id: 'platform', label: 'Platform', icon: <Waypoints className="h-4 w-4" />, render: () => <PlatformTab /> },
    { id: 'accounts', label: 'Accounts', icon: <Link2 className="h-4 w-4" />, render: () => <AccountsTab /> },
    { id: 'remote-mcps', label: 'MCPs', icon: <Plug className="h-4 w-4" />, render: () => <RemoteMcpsTab /> },
    { id: 'usage', label: 'Usage', icon: <BarChart3 className="h-4 w-4" />, render: () => <UsageTab /> },
  ]

  const adminSections: SettingsPageSection[] = [
    { id: 'llm', label: 'LLM', icon: <Brain className="h-4 w-4" />, render: () => <LlmTab /> },
    { id: 'runtime', label: 'Runtime', icon: <Container className="h-4 w-4" />, render: () => <RuntimeTab /> },
    { id: 'browser', label: 'Browser Use', icon: <Globe className="h-4 w-4" />, render: () => <BrowserTab /> },
    ...(isElectron() ? [{ id: 'computer-use', label: 'Computer Use', icon: <Terminal className="h-4 w-4" />, render: () => <ComputerUseTab /> }] : []),
    { id: 'composio', label: 'Account Provider', icon: <ShieldEllipsis className="h-4 w-4" />, render: () => <ComposioTab /> },
    { id: 'voice', label: 'Voice', icon: <Mic className="h-4 w-4" />, render: () => <VoiceTab /> },
    { id: 'skillsets', label: 'Skillsets', icon: <Library className="h-4 w-4" />, render: () => <SkillsetsTab /> },
    ...(isAuthMode ? [{ id: 'analytics', label: 'Analytics', icon: <Activity className="h-4 w-4" />, render: () => <AnalyticsTab /> }] : []),
    { id: 'admin', label: 'Admin', icon: <Settings className="h-4 w-4" />, render: () => <AdminTab /> },
  ]

  const authAdminSections: SettingsPageSection[] = [
    { id: 'users', label: 'Users', icon: <Users className="h-4 w-4" />, render: () => <UsersTab /> },
    { id: 'auth', label: 'Auth', icon: <Shield className="h-4 w-4" />, render: () => <AuthTab /> },
  ]

  const groups: SettingsPageSectionGroup[] = showSectionHeaders
    ? [
        { label: 'My Settings', sections: userSections },
        { label: 'Admin Settings', sections: [...adminSections, ...authAdminSections] },
      ]
    : [
        {
          sections: [
            ...userSections,
            ...(showAdminSettings ? adminSections : []),
            ...(showAuthAdmin ? authAdminSections : []),
          ],
        },
      ]

  return (
    <SettingsPage
      groups={groups}
      onClose={onClose}
      initialSection={initialSection}
      data-testid="global-settings-page"
      navTestIdPrefix="settings"
    />
  )
}
