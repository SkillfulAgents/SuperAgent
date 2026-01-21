'use client'

import * as React from 'react'
import { Settings, FileText, KeyRound, Sparkles, Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar'
import { useUpdateAgent, type AgentWithStatus } from '@/lib/hooks/use-agents'
import { GeneralTab } from './settings/general-tab'
import { SystemPromptTab } from './settings/system-prompt-tab'
import { SecretsTab } from './settings/secrets-tab'
import { SkillsTab } from './settings/skills-tab'
import { ConnectedAccountsTab } from './settings/connected-accounts-tab'

type SettingsSection = 'general' | 'system-prompt' | 'secrets' | 'skills' | 'connected-accounts'

const navItems = [
  { id: 'general' as const, name: 'General', icon: Settings },
  { id: 'system-prompt' as const, name: 'System Prompt', icon: FileText },
  { id: 'secrets' as const, name: 'Secrets', icon: KeyRound },
  { id: 'skills' as const, name: 'Skills', icon: Sparkles },
  { id: 'connected-accounts' as const, name: 'Accounts', icon: Link2 },
]

interface AgentSettingsDialogProps {
  agent: AgentWithStatus
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AgentSettingsDialog({
  agent,
  open,
  onOpenChange,
}: AgentSettingsDialogProps) {
  const [activeSection, setActiveSection] = React.useState<SettingsSection>('general')
  const [name, setName] = React.useState(agent.name)
  const [systemPrompt, setSystemPrompt] = React.useState(agent.systemPrompt || '')
  const updateAgent = useUpdateAgent()

  // Reset form when dialog opens with new agent data
  React.useEffect(() => {
    if (open) {
      setName(agent.name)
      setSystemPrompt(agent.systemPrompt || '')
      setActiveSection('general')
    }
  }, [open, agent.name, agent.systemPrompt])

  const handleSave = async () => {
    await updateAgent.mutateAsync({
      id: agent.id,
      name: name.trim() || agent.name,
      systemPrompt: systemPrompt.trim() || null,
    })
    onOpenChange(false)
  }

  const hasChanges = name !== agent.name || systemPrompt !== (agent.systemPrompt || '')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 md:max-h-[500px] md:max-w-[700px] lg:max-w-[800px]">
        <DialogTitle className="sr-only">Agent Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure settings for {agent.name}
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
              {activeSection === 'general' && (
                <GeneralTab
                  name={name}
                  agentId={agent.id}
                  onNameChange={setName}
                  onDialogClose={() => onOpenChange(false)}
                />
              )}
              {activeSection === 'system-prompt' && (
                <SystemPromptTab
                  systemPrompt={systemPrompt}
                  onSystemPromptChange={setSystemPrompt}
                />
              )}
              {activeSection === 'secrets' && (
                <SecretsTab agentId={agent.id} isOpen={open} />
              )}
              {activeSection === 'skills' && (
                <SkillsTab agentId={agent.id} />
              )}
              {activeSection === 'connected-accounts' && (
                <ConnectedAccountsTab agentId={agent.id} />
              )}
            </div>
            {activeSection !== 'secrets' && activeSection !== 'skills' && activeSection !== 'connected-accounts' && (
              <div className="flex items-center justify-end gap-2 border-t p-4">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={!hasChanges || updateAgent.isPending}
                >
                  {updateAgent.isPending ? 'Saving...' : 'Save'}
                </Button>
              </div>
            )}
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  )
}
