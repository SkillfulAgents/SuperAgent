
import * as React from 'react'
import { Settings, Link2, Container, Bell, Globe, Library, BarChart3, Plug, Brain, Users, Shield, ShieldEllipsis } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@renderer/components/ui/sidebar'
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
import { useUser } from '@renderer/context/user-context'

type SettingsSection = 'general' | 'llm' | 'notifications' | 'runtime' | 'browser' | 'composio' | 'accounts' | 'remote-mcps' | 'skillsets' | 'usage' | 'users' | 'auth' | 'admin'

// Always visible to all users
const userNavItems = [
  { id: 'general' as const, name: 'General', icon: Settings },
  { id: 'notifications' as const, name: 'Notifications', icon: Bell },
  { id: 'accounts' as const, name: 'Accounts', icon: Link2 },
  { id: 'remote-mcps' as const, name: 'MCPs', icon: Plug },
  { id: 'usage' as const, name: 'Usage', icon: BarChart3 },
]

// Visible in non-auth mode (everyone is admin) or when user is admin in auth mode
const adminSettingsNavItems = [
  { id: 'llm' as const, name: 'LLM', icon: Brain },
  { id: 'runtime' as const, name: 'Runtime', icon: Container },
  { id: 'browser' as const, name: 'Browser Use', icon: Globe },
  { id: 'composio' as const, name: 'Account Provider', icon: ShieldEllipsis },
  { id: 'skillsets' as const, name: 'Skillsets', icon: Library },
  { id: 'admin' as const, name: 'Admin', icon: Settings },
]

// Only visible to admins in auth mode
const authAdminNavItems = [
  { id: 'users' as const, name: 'Users', icon: Users },
  { id: 'auth' as const, name: 'Auth', icon: Shield },
]

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
  const navGroups = React.useMemo(() => {
    type NavItem = { id: SettingsSection; name: string; icon: typeof Settings }
    const groups: { label?: string; items: NavItem[] }[] = []

    if (showSectionHeaders) {
      groups.push({ label: 'My Settings', items: [...userNavItems] })
      const adminItems: NavItem[] = [...adminSettingsNavItems, ...authAdminNavItems]
      groups.push({ label: 'Admin Settings', items: adminItems })
    } else {
      const items: NavItem[] = [...userNavItems]
      if (showAdminSettings) items.push(...adminSettingsNavItems)
      groups.push({ items })
    }

    return groups
  }, [showAdminSettings, showSectionHeaders])

  const allNavItems = React.useMemo(
    () => navGroups.flatMap((g) => g.items),
    [navGroups]
  )

  const [activeSection, setActiveSection] = React.useState<SettingsSection>('general')

  // Reset tab when dialog opens (use initialTab if provided)
  React.useEffect(() => {
    if (open) {
      const tab = initialTab as SettingsSection | undefined
      setActiveSection(tab && allNavItems.some(item => item.id === tab) ? tab : 'general')
    }
  }, [open, initialTab, allNavItems])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 md:max-h-[500px] md:max-w-[700px] lg:max-w-[800px]" data-testid="global-settings-dialog">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure global application settings
        </DialogDescription>
        <SidebarProvider className="items-start min-h-0">
          <Sidebar collapsible="none" className="hidden md:flex w-48 max-h-[480px]">
            <SidebarContent>
              {navGroups.map((group, i) => (
                <SidebarGroup key={i}>
                  {group.label && (
                    <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                  )}
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {group.items.map((item) => (
                        <SidebarMenuItem key={item.id}>
                          <SidebarMenuButton
                            isActive={activeSection === item.id}
                            onClick={() => setActiveSection(item.id)}
                            data-testid={`settings-nav-${item.id}`}
                          >
                            <item.icon className="h-4 w-4" />
                            <span>{item.name}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              ))}
            </SidebarContent>
          </Sidebar>
          <main className="flex h-[480px] flex-1 flex-col overflow-hidden">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
              <span className="text-sm text-muted-foreground">Settings</span>
              <span className="text-sm text-muted-foreground">/</span>
              <span className="text-sm font-medium">
                {allNavItems.find((item) => item.id === activeSection)?.name}
              </span>
            </header>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
              {activeSection === 'general' && <GeneralTab onOpenWizard={onOpenWizard} />}
              {activeSection === 'notifications' && <NotificationsTab />}
              {activeSection === 'accounts' && <AccountsTab />}
              {activeSection === 'remote-mcps' && <RemoteMcpsTab />}
              {activeSection === 'usage' && <UsageTab />}
              {activeSection === 'llm' && showAdminSettings && <LlmTab />}
              {activeSection === 'runtime' && showAdminSettings && <RuntimeTab />}
              {activeSection === 'browser' && showAdminSettings && <BrowserTab />}
              {activeSection === 'composio' && showAdminSettings && <ComposioTab />}
              {activeSection === 'skillsets' && showAdminSettings && <SkillsetsTab />}
              {activeSection === 'admin' && showAdminSettings && <AdminTab />}
              {activeSection === 'users' && showAuthAdmin && <UsersTab />}
              {activeSection === 'auth' && showAuthAdmin && <AuthTab />}
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  )
}
