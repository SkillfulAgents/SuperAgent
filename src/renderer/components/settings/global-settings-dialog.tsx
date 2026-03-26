
import { Settings, Link2, Container, Bell, Globe, Library, BarChart3, Plug, Brain, Users, Shield, ShieldEllipsis, User, Mic, Activity, Terminal } from 'lucide-react'
import { SettingsDialog, SettingsDialogTab, SettingsDialogGroup } from '@renderer/components/ui/settings-dialog'
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
import { ComputerUseTab } from './computer-use-tab'
import { useUser } from '@renderer/context/user-context'
import { isElectron } from '@renderer/lib/env'

interface GlobalSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenWizard: () => void
  initialTab?: string
}

export function GlobalSettingsDialog({
  open,
  onOpenChange,
  onOpenWizard,
  initialTab,
}: GlobalSettingsDialogProps) {
  const { isAuthMode, isAdmin } = useUser()
  const showAdminSettings = !isAuthMode || isAdmin
  const showAuthAdmin = isAuthMode && isAdmin
  const showSectionHeaders = isAuthMode && isAdmin

  const userTabs = (
    <>
      {isAuthMode && (
        <SettingsDialogTab id="profile" label="Profile & Login" icon={<User className="h-4 w-4" />}>
          <ProfileTab />
        </SettingsDialogTab>
      )}
      <SettingsDialogTab id="general" label="General" icon={<Settings className="h-4 w-4" />}>
        <GeneralTab onOpenWizard={onOpenWizard} />
      </SettingsDialogTab>
      <SettingsDialogTab id="notifications" label="Notifications" icon={<Bell className="h-4 w-4" />}>
        <NotificationsTab />
      </SettingsDialogTab>
      <SettingsDialogTab id="accounts" label="Accounts" icon={<Link2 className="h-4 w-4" />}>
        <AccountsTab />
      </SettingsDialogTab>
      <SettingsDialogTab id="remote-mcps" label="MCPs" icon={<Plug className="h-4 w-4" />}>
        <RemoteMcpsTab />
      </SettingsDialogTab>
      <SettingsDialogTab id="usage" label="Usage" icon={<BarChart3 className="h-4 w-4" />}>
        <UsageTab />
      </SettingsDialogTab>
    </>
  )

  const adminTabs = (
    <>
      <SettingsDialogTab id="llm" label="LLM" icon={<Brain className="h-4 w-4" />}>
        <LlmTab />
      </SettingsDialogTab>
      <SettingsDialogTab id="runtime" label="Runtime" icon={<Container className="h-4 w-4" />}>
        <RuntimeTab />
      </SettingsDialogTab>
      <SettingsDialogTab id="browser" label="Browser Use" icon={<Globe className="h-4 w-4" />}>
        <BrowserTab />
      </SettingsDialogTab>
      {isElectron() && (
        <SettingsDialogTab id="computer-use" label="Computer Use" icon={<Terminal className="h-4 w-4" />}>
          <ComputerUseTab />
        </SettingsDialogTab>
      )}
      <SettingsDialogTab id="composio" label="Account Provider" icon={<ShieldEllipsis className="h-4 w-4" />}>
        <ComposioTab />
      </SettingsDialogTab>
      <SettingsDialogTab id="voice" label="Voice" icon={<Mic className="h-4 w-4" />}>
        <VoiceTab />
      </SettingsDialogTab>
      <SettingsDialogTab id="skillsets" label="Skillsets" icon={<Library className="h-4 w-4" />}>
        <SkillsetsTab />
      </SettingsDialogTab>
      {isAuthMode && (
        <SettingsDialogTab id="analytics" label="Analytics" icon={<Activity className="h-4 w-4" />}>
          <AnalyticsTab />
        </SettingsDialogTab>
      )}
      <SettingsDialogTab id="admin" label="Admin" icon={<Settings className="h-4 w-4" />}>
        <AdminTab />
      </SettingsDialogTab>
    </>
  )

  const authAdminTabs = (
    <>
      <SettingsDialogTab id="users" label="Users" icon={<Users className="h-4 w-4" />}>
        <UsersTab />
      </SettingsDialogTab>
      <SettingsDialogTab id="auth" label="Auth" icon={<Shield className="h-4 w-4" />}>
        <AuthTab />
      </SettingsDialogTab>
    </>
  )

  return (
    <SettingsDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      description="Configure global application settings"
      initialTab={initialTab}
      data-testid="global-settings-dialog"
      navTestIdPrefix="settings"
    >
      {showSectionHeaders ? (
        <>
          <SettingsDialogGroup label="My Settings">
            {userTabs}
          </SettingsDialogGroup>
          <SettingsDialogGroup label="Admin Settings">
            {adminTabs}
            {authAdminTabs}
          </SettingsDialogGroup>
        </>
      ) : (
        <>
          {userTabs}
          {showAdminSettings && adminTabs}
          {showAuthAdmin && authAdminTabs}
        </>
      )}
    </SettingsDialog>
  )
}
