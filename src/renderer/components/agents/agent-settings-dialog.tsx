
import * as React from 'react'
import { Settings, KeyRound, Sparkles, Link2, ScrollText, Plug, Users, HardDrive, MessageCircle, Network } from 'lucide-react'
import { useUser } from '@renderer/context/user-context'
import { Button } from '@renderer/components/ui/button'
import { SettingsDialog, SettingsDialogTab } from '@renderer/components/ui/settings-dialog'
import { useUpdateAgent, type ApiAgent } from '@renderer/hooks/use-agents'
import { GeneralTab } from './settings/general-tab'
import { SecretsTab } from './settings/secrets-tab'
import { SkillsTab } from './settings/skills-tab'
import { ConnectedAccountsTab } from './settings/connected-accounts-tab'
import { RemoteMcpsTab } from './settings/remote-mcps-tab'
import { AuditLogTab } from './settings/audit-log-tab'
import { AccessTab } from './settings/access-tab'
import { VolumesTab } from './settings/volumes-tab'
import { ChatIntegrationsTab } from './settings/chat-integrations-tab'
import { XAgentPoliciesTab } from './settings/x-agent-policies-tab'

interface AgentSettingsDialogProps {
  agent: ApiAgent
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: string
}

export function AgentSettingsDialog({
  agent,
  open,
  onOpenChange,
  initialTab,
}: AgentSettingsDialogProps) {
  const [name, setName] = React.useState(agent.name)
  const updateAgent = useUpdateAgent()
  const { isAuthMode, canAdminAgent, rolesReady } = useUser()
  const isOwner = canAdminAgent(agent.slug)

  // Reset form when dialog opens with new agent data
  React.useEffect(() => {
    if (open) {
      setName(agent.name)
    }
  }, [open, agent.name])

  const handleSave = async () => {
    await updateAgent.mutateAsync({
      slug: agent.slug,
      name: name.trim() || agent.name,
    })
    onOpenChange(false)
  }

  const hasChanges = name !== agent.name

  const saveFooter = (
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
  )

  const permissionOverlay = isAuthMode && rolesReady && !isOwner ? (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-lg" data-testid="agent-settings-no-permission">
      <div className="text-center space-y-2">
        <p className="text-sm font-medium">You don&apos;t have permission to edit settings</p>
        <p className="text-xs text-muted-foreground">Only agent owners can modify settings.</p>
      </div>
    </div>
  ) : undefined

  return (
    <SettingsDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      description={`Configure settings for ${agent.name}`}
      initialTab={initialTab}
      overlay={permissionOverlay}
      inert={isAuthMode && rolesReady && !isOwner}
      data-testid="agent-settings-dialog"
      navTestIdPrefix="agent-settings"
    >
      <SettingsDialogTab id="general" label="General" icon={<Settings className="h-4 w-4" />} footer={saveFooter}>
        <GeneralTab
          name={name}
          agentSlug={agent.slug}
          onNameChange={setName}
          onDialogClose={() => onOpenChange(false)}
        />
      </SettingsDialogTab>
      <SettingsDialogTab id="secrets" label="Secrets" icon={<KeyRound className="h-4 w-4" />}>
        <SecretsTab agentSlug={agent.slug} isOpen={open} />
      </SettingsDialogTab>
      <SettingsDialogTab id="skills" label="Skills" icon={<Sparkles className="h-4 w-4" />}>
        <SkillsTab agentSlug={agent.slug} />
      </SettingsDialogTab>
      {!!window.electronAPI && (
        <SettingsDialogTab id="volumes" label="Volumes" icon={<HardDrive className="h-4 w-4" />}>
          <VolumesTab agentSlug={agent.slug} />
        </SettingsDialogTab>
      )}
      <SettingsDialogTab id="connected-accounts" label="Accounts" icon={<Link2 className="h-4 w-4" />}>
        <ConnectedAccountsTab agentSlug={agent.slug} />
      </SettingsDialogTab>
      <SettingsDialogTab id="chat-integrations" label="Chat" icon={<MessageCircle className="h-4 w-4" />}>
        <ChatIntegrationsTab agentSlug={agent.slug} />
      </SettingsDialogTab>
      <SettingsDialogTab id="remote-mcps" label="MCPs" icon={<Plug className="h-4 w-4" />}>
        <RemoteMcpsTab agentSlug={agent.slug} onClose={() => onOpenChange(false)} />
      </SettingsDialogTab>
      <SettingsDialogTab id="x-agent-policies" label="Agents" icon={<Network className="h-4 w-4" />}>
        <XAgentPoliciesTab agentSlug={agent.slug} />
      </SettingsDialogTab>
      <SettingsDialogTab id="audit-log" label="API Log" icon={<ScrollText className="h-4 w-4" />}>
        <AuditLogTab agentSlug={agent.slug} />
      </SettingsDialogTab>
      {isAuthMode && (
        <SettingsDialogTab id="access" label="Access" icon={<Users className="h-4 w-4" />}>
          <AccessTab agentSlug={agent.slug} />
        </SettingsDialogTab>
      )}
    </SettingsDialog>
  )
}
