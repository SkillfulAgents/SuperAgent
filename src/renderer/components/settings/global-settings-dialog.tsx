
import * as React from 'react'
import { Settings, Link2, Container, Bell, Globe, Library } from 'lucide-react'
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

type SettingsSection = 'general' | 'notifications' | 'runtime' | 'browser' | 'composio' | 'skillsets'

const navItems = [
  { id: 'general' as const, name: 'General', icon: Settings },
  { id: 'notifications' as const, name: 'Notifications', icon: Bell },
  { id: 'runtime' as const, name: 'Runtime', icon: Container },
  { id: 'browser' as const, name: 'Browser Use', icon: Globe },
  { id: 'composio' as const, name: 'Accounts', icon: Link2 },
  { id: 'skillsets' as const, name: 'Skillsets', icon: Library },
]

interface GlobalSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenWizard: () => void
}

export function GlobalSettingsDialog({
  open,
  onOpenChange,
  onOpenWizard,
}: GlobalSettingsDialogProps) {
  const [activeSection, setActiveSection] = React.useState<SettingsSection>('general')

  // Reset to general tab when dialog opens
  React.useEffect(() => {
    if (open) {
      setActiveSection('general')
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 md:max-h-[500px] md:max-w-[700px] lg:max-w-[800px]">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure global application settings
        </DialogDescription>
        <SidebarProvider className="items-start">
          <Sidebar collapsible="none" className="hidden md:flex w-48">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {navItems.map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          isActive={activeSection === item.id}
                          onClick={() => setActiveSection(item.id)}
                        >
                          <item.icon className="h-4 w-4" />
                          <span>{item.name}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <main className="flex h-[480px] flex-1 flex-col overflow-hidden">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
              <span className="text-sm text-muted-foreground">Settings</span>
              <span className="text-sm text-muted-foreground">/</span>
              <span className="text-sm font-medium">
                {navItems.find((item) => item.id === activeSection)?.name}
              </span>
            </header>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
              {activeSection === 'general' && <GeneralTab onOpenWizard={onOpenWizard} />}
              {activeSection === 'notifications' && <NotificationsTab />}
              {activeSection === 'runtime' && <RuntimeTab />}
              {activeSection === 'browser' && <BrowserTab />}
              {activeSection === 'composio' && <ComposioTab />}
              {activeSection === 'skillsets' && <SkillsetsTab />}
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  )
}
