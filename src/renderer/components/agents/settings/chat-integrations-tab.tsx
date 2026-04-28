/**
 * Chat Integrations Tab — settings for managing external chat connections.
 *
 * Shows existing integrations, allows adding Telegram/Slack,
 * with setup instructions and credential validation.
 */

import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import {
  useChatIntegrations,
  useCreateChatIntegration,
  useDeleteChatIntegration,
  useUpdateChatIntegration,
  useTestChatIntegrationCredentials,
  ChatIntegrationApiError,
} from '@renderer/hooks/use-chat-integrations'
import {
  Plus,
  Trash2,
  Loader2,
  MessageCircle,
  CheckCircle,
  AlertCircle,
  Pause,
  Play,
  Copy,
  Check,
} from 'lucide-react'
import { formatProviderName } from '@shared/lib/chat-integrations/utils'

function generateSlackManifest(botName: string): string {
  return JSON.stringify({
    display_information: { name: botName },
    features: {
      bot_user: { display_name: botName, always_online: false },
    },
    oauth_config: {
      scopes: {
        bot: ['users:read', 'chat:write', 'files:read', 'files:write', 'im:history', 'im:read', 'im:write', 'reactions:write'],
      },
    },
    settings: {
      event_subscriptions: { bot_events: ['message.im'] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  }, null, 2)
}
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@renderer/components/ui/alert-dialog'

interface ChatIntegrationsTabProps {
  agentSlug: string
}

type Provider = 'telegram' | 'slack'

const PROVIDER_INFO = {
  telegram: {
    label: 'Telegram',
    slug: 'telegram',
    steps: [
      'Open Telegram and search for @BotFather',
      'Send /newbot and choose a display name and username (must end with "bot")',
      'Copy the Bot Token (format: 123456789:ABCdefGHI...)',
      'Paste it below',
      'Open a chat with your new bot and send /start',
    ],
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: '123456789:ABCdefGHIjklMNO...', type: 'password' as const },
      { key: 'chatId', label: 'Chat ID (optional)', placeholder: 'Auto-detected on first message', type: 'text' as const },
    ],
  },
  slack: {
    label: 'Slack',
    slug: 'slack',
    steps: [
      <>Go to <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline text-primary hover:text-primary/80">api.slack.com/apps</a> &rarr; &ldquo;Create New App&rdquo; &rarr; &ldquo;From scratch&rdquo;</>,
      'Enable Socket Mode (Settings → Socket Mode → toggle ON)',
      'Generate App-Level Token (Basic Information → App-Level Tokens → Generate Token with connections:write scope)',
      'Add Bot Token Scopes (OAuth & Permissions → Scopes → Bot Token Scopes): chat:write, im:history, im:read, im:write, users:read, files:read, files:write, reactions:write',
      'Subscribe to events (Event Subscriptions → toggle ON → Subscribe to bot events → add message.im)',
      'Enable Interactivity (Interactivity & Shortcuts → toggle ON)',
      'Enable App Home messaging (App Home → Show Tabs → check "Messages Tab" AND check "Allow users to send Slash commands and messages from the messages tab")',
      'Install to Workspace (OAuth & Permissions → Install to Workspace) and copy the Bot Token (xoxb-...)',
    ],
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: 'xoxb-...', type: 'password' as const },
      { key: 'appToken', label: 'App-Level Token', placeholder: 'xapp-...', type: 'password' as const },
      { key: 'channelId', label: 'Channel ID (optional)', placeholder: 'Auto-detected from DMs', type: 'text' as const },
    ],
  },
}

export function ChatIntegrationsTab({ agentSlug }: ChatIntegrationsTabProps) {
  const { data: integrations, isLoading } = useChatIntegrations(agentSlug)
  const createIntegration = useCreateChatIntegration()
  const deleteIntegration = useDeleteChatIntegration()
  const updateIntegration = useUpdateChatIntegration()
  const testCredentials = useTestChatIntegrationCredentials()

  const [isAdding, setIsAdding] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null)
  const [formData, setFormData] = useState<Record<string, string>>({})
  const [integrationName, setIntegrationName] = useState('')
  const [showToolCalls, setShowToolCalls] = useState(false)
  const [testResult, setTestResult] = useState<{ valid: boolean; info?: string } | null>(null)
  const [slackSetupMode, setSlackSetupMode] = useState<'manifest' | 'manual'>('manifest')
  const [manifestCopied, setManifestCopied] = useState(false)

  const resetForm = () => {
    setIsAdding(false)
    setSelectedProvider(null)
    setFormData({})
    setIntegrationName('')
    setShowToolCalls(false)
    setTestResult(null)
    setManifestCopied(false)
  }

  const handleTest = async () => {
    if (!selectedProvider) return
    setTestResult(null)
    try {
      const result = await testCredentials.mutateAsync({
        provider: selectedProvider,
        config: formData,
      })
      const info = selectedProvider === 'telegram'
        ? `Bot: @${result.botUsername || result.botName}`
        : `Workspace: ${result.team}`
      setTestResult({ valid: true, info })
    } catch (err) {
      setTestResult({ valid: false, info: err instanceof Error ? err.message : 'Invalid credentials' })
    }
  }

  const handleCreate = async () => {
    if (!selectedProvider) return
    try {
      await createIntegration.mutateAsync({
        agentSlug,
        provider: selectedProvider,
        name: integrationName.trim() || undefined,
        config: formData,
        showToolCalls,
      })
      resetForm()
    } catch {
      // Error handled by mutation
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteIntegration.mutateAsync({ id, agentSlug })
    } catch {
      // Error handled by mutation
    }
  }

  const handleTogglePause = async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === 'paused' ? 'active' : 'paused'
    await updateIntegration.mutateAsync({ id, status: newStatus as 'active' | 'paused' })
  }

  const handleToggleToolCalls = async (id: string, current: boolean) => {
    await updateIntegration.mutateAsync({ id, showToolCalls: !current })
  }

  const statusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400"><CheckCircle className="h-3 w-3" /> Active</span>
      case 'paused':
        return <span className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400"><Pause className="h-3 w-3" /> Paused</span>
      case 'error':
        return <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400"><AlertCircle className="h-3 w-3" /> Error</span>
      case 'disconnected':
        return <span className="flex items-center gap-1 text-xs text-gray-500"><AlertCircle className="h-3 w-3" /> Disconnected</span>
      default:
        return null
    }
  }

  const ProviderIcon = ({ provider, className }: { provider: string; className?: string }) => (
    <ServiceIcon slug={provider} fallback="mcp" className={className || 'h-5 w-5'} />
  )

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-medium">Chat Integrations</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Connect external messaging apps to chat with this agent from Telegram or Slack.
          </p>
        </div>
        {!isAdding && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsAdding(true)}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Integration
          </Button>
        )}
      </div>

      {/* Existing integrations */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading integrations...
        </div>
      ) : integrations && integrations.length > 0 ? (
        <div className="space-y-2">
          {integrations.map((integration) => (
            <div
              key={integration.id}
              className="flex items-start justify-between p-3 rounded-md border bg-muted/30"
            >
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <ProviderIcon provider={integration.provider} className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">
                      {integration.name || `${formatProviderName(integration.provider)} Bot`}
                    </p>
                    {statusBadge(integration.status)}
                  </div>
                  <p className="text-xs text-muted-foreground capitalize">{integration.provider}</p>
                  {integration.errorMessage && (
                    <p className="text-xs text-red-500 mt-1">{integration.errorMessage}</p>
                  )}
                  <div className="flex items-center gap-2 mt-2">
                    <Checkbox
                      id={`tool-calls-${integration.id}`}
                      checked={integration.showToolCalls}
                      onCheckedChange={() => handleToggleToolCalls(integration.id, integration.showToolCalls)}
                    />
                    <label
                      htmlFor={`tool-calls-${integration.id}`}
                      className="text-xs text-muted-foreground cursor-pointer"
                    >
                      Show tool calls
                    </label>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0 ml-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleTogglePause(integration.id, integration.status)}
                  disabled={updateIntegration.isPending}
                  title={integration.status === 'paused' ? 'Resume' : 'Pause'}
                >
                  {integration.status === 'paused' ? (
                    <Play className="h-3 w-3" />
                  ) : (
                    <Pause className="h-3 w-3" />
                  )}
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="ghost" title="Delete">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete Chat Integration</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will disconnect the bot and remove this integration. This cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => handleDelete(integration.id)}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          ))}
        </div>
      ) : !isAdding ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <MessageCircle className="h-8 w-8 text-muted-foreground/50" />
          <div>
            <p className="text-sm text-muted-foreground">No chat integrations yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Connect Telegram or Slack to chat with your agent from anywhere.
            </p>
          </div>
        </div>
      ) : null}

      {/* Add integration flow */}
      {isAdding && !selectedProvider && (
        <div className="space-y-3 p-4 border rounded-md">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">Choose a Platform</Label>
            <Button size="sm" variant="ghost" onClick={resetForm}>Cancel</Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {(['telegram', 'slack'] as const).map((provider) => {
              const info = PROVIDER_INFO[provider]
              return (
                <button
                  key={provider}
                  type="button"
                  className="flex items-center gap-3 p-4 rounded-md border bg-card text-left hover:bg-accent/50 transition-colors"
                  onClick={() => setSelectedProvider(provider)}
                >
                  <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <ServiceIcon slug={info.slug} fallback="mcp" className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{info.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {provider === 'telegram' ? 'Bot API via long polling' : 'Socket Mode (no webhooks)'}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {isAdding && selectedProvider && (
        <div className="space-y-4 p-4 border rounded-md">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ServiceIcon slug={PROVIDER_INFO[selectedProvider].slug} fallback="mcp" className="h-5 w-5" />
              <Label className="text-sm font-medium">
                Setup {PROVIDER_INFO[selectedProvider].label}
              </Label>
            </div>
            <Button size="sm" variant="ghost" onClick={resetForm}>Cancel</Button>
          </div>

          {/* Setup instructions */}
          {selectedProvider === 'slack' && (
            <div className="flex gap-1 rounded-md bg-muted/50 p-1">
              <button
                type="button"
                className={`flex-1 px-3 py-1 rounded text-xs font-medium transition-colors ${slackSetupMode === 'manifest' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setSlackSetupMode('manifest')}
              >
                App Manifest (Quick)
              </button>
              <button
                type="button"
                className={`flex-1 px-3 py-1 rounded text-xs font-medium transition-colors ${slackSetupMode === 'manual' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setSlackSetupMode('manual')}
              >
                Manual Setup
              </button>
            </div>
          )}

          {selectedProvider === 'slack' && slackSetupMode === 'manifest' ? (
            <div className="rounded-md bg-muted/50 p-3 space-y-3">
              <p className="text-xs font-medium text-muted-foreground">Setup with App Manifest:</p>
              <ol className="list-decimal list-inside space-y-1">
                <li className="text-xs text-muted-foreground">
                  Go to <a href="https://api.slack.com/apps?new_app=1&manifest_format=json" target="_blank" rel="noopener noreferrer" className="underline text-primary hover:text-primary/80">api.slack.com/apps</a> → &quot;Create New App&quot; → &quot;From an app manifest&quot;
                </li>
                <li className="text-xs text-muted-foreground">Select your workspace, then paste the manifest below</li>
                <li className="text-xs text-muted-foreground">Create the app, then go to Basic Information → App-Level Tokens → Generate Token with <code className="bg-muted px-1 rounded">connections:write</code> scope</li>
                <li className="text-xs text-muted-foreground">Install to Workspace (OAuth & Permissions → Install to Workspace) and copy the Bot Token (xoxb-...)</li>
              </ol>
              <div className="relative">
                <pre className="text-2xs leading-relaxed bg-background border rounded-md p-2 overflow-x-auto max-h-40 select-all">
                  {generateSlackManifest(integrationName.trim() || 'SuperAgent Bot')}
                </pre>
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute top-1 right-1 h-6 px-2"
                  onClick={async () => {
                    await navigator.clipboard.writeText(generateSlackManifest(integrationName.trim() || 'SuperAgent Bot'))
                    setManifestCopied(true)
                    setTimeout(() => setManifestCopied(false), 2000)
                  }}
                >
                  {manifestCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                </Button>
              </div>
              <p className="text-2xs text-muted-foreground/70">Tip: set the Name field above first — it will be used in the manifest.</p>
            </div>
          ) : (
            <div className="rounded-md bg-muted/50 p-3">
              <p className="text-xs font-medium text-muted-foreground mb-2">Setup Instructions:</p>
              <ol className="list-decimal list-inside space-y-1">
                {PROVIDER_INFO[selectedProvider].steps.map((step, i) => (
                  <li key={i} className="text-xs text-muted-foreground">{step}</li>
                ))}
              </ol>
            </div>
          )}

          {/* Credential fields */}
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Name (optional)</Label>
              <Input
                value={integrationName}
                onChange={(e) => setIntegrationName(e.target.value)}
                placeholder={`My ${PROVIDER_INFO[selectedProvider].label} Bot`}
                className="mt-1"
              />
            </div>

            {PROVIDER_INFO[selectedProvider].fields.map((field) => (
              <div key={field.key}>
                <Label className="text-xs">{field.label}</Label>
                <Input
                  type={field.type}
                  value={formData[field.key] || ''}
                  onChange={(e) => setFormData({ ...formData, [field.key]: e.target.value })}
                  placeholder={field.placeholder}
                  className="mt-1"
                />
              </div>
            ))}

            <div className="flex items-center gap-2">
              <Checkbox
                id="new-show-tool-calls"
                checked={showToolCalls}
                onCheckedChange={(checked) => setShowToolCalls(checked === true)}
              />
              <label
                htmlFor="new-show-tool-calls"
                className="text-xs text-muted-foreground cursor-pointer"
              >
                Show tool calls in chat
              </label>
            </div>
          </div>

          {/* Test result */}
          {testResult && (
            <div className={`flex items-center gap-2 p-2 rounded-md border ${
              testResult.valid
                ? 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950'
                : 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950'
            }`}>
              {testResult.valid ? (
                <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
              ) : (
                <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
              )}
              <p className={`text-xs ${testResult.valid ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {testResult.info}
              </p>
            </div>
          )}

          {createIntegration.error && (
            <p className="text-xs text-red-500">
              {createIntegration.error instanceof ChatIntegrationApiError && createIntegration.error.code === 'duplicate_bot_token'
                ? 'This bot is already connected to another integration. Remove the existing one first, or use a different bot.'
                : createIntegration.error.message}
            </p>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleTest}
              disabled={testCredentials.isPending || !formData[PROVIDER_INFO[selectedProvider].fields[0].key]}
            >
              {testCredentials.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Testing...</>
              ) : (
                'Test Credentials'
              )}
            </Button>
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={createIntegration.isPending || !formData[PROVIDER_INFO[selectedProvider].fields[0].key]}
            >
              {createIntegration.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating...</>
              ) : (
                'Create Integration'
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
