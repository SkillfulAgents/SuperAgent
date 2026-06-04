/**
 * Chat Integration Setup Dialog — standalone per-provider setup flow.
 *
 * Opened from the agent home "Chat via …" rows or the Chat settings tab.
 * Renders provider-specific instructions, credential fields, credential
 * testing, and creation. One dialog instance handles a single provider; the
 * inner form is keyed by provider so state resets when the provider changes.
 */

import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  useCreateChatIntegration,
  useTestChatIntegrationCredentials,
  ChatIntegrationApiError,
} from '@renderer/hooks/use-chat-integrations'
import { Loader2, CheckCircle, AlertCircle, Copy, Check, Eye, EyeOff } from 'lucide-react'
import type { ChatProvider } from '@shared/lib/chat-integrations/config-schema'

function generateSlackManifest(botName: string): string {
  return JSON.stringify({
    display_information: { name: botName },
    features: {
      bot_user: { display_name: botName, always_online: true },
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          'users:read',
          'chat:write',
          'files:read',
          'files:write',
          'im:history',
          'im:read',
          'im:write',
          'channels:history',
          'channels:read',
          'groups:history',
          'groups:read',
          'mpim:history',
          'mpim:read',
          'reactions:write',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: ['message.im', 'message.channels', 'message.groups', 'message.mpim'],
      },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  }, null, 2)
}

const IMESSAGE_SETUP_NUMBER_RAW = '+12053967934'
const IMESSAGE_SETUP_NUMBER_DISPLAY = '+1 (205) 396-7934'

function PhoneNumberCopyButton() {
  const smsUrl = `sms:${IMESSAGE_SETUP_NUMBER_RAW}&body=${encodeURIComponent('/setup')}`
  return (
    <a
      href={smsUrl}
      onClick={(e) => {
        if (window.electronAPI) {
          e.preventDefault()
          window.electronAPI.openExternal(smsUrl)
        }
      }}
      className="underline text-primary hover:text-primary/80 whitespace-nowrap"
    >
      {IMESSAGE_SETUP_NUMBER_DISPLAY}
    </a>
  )
}

const PROVIDER_INFO: Record<ChatProvider, {
  label: string
  slug: string
  steps: Array<string | React.ReactNode>
  note?: React.ReactNode
  fields: Array<{ key: string; label: string; placeholder: string; type: 'text' | 'password'; optional?: boolean }>
}> = {
  telegram: {
    label: 'Telegram',
    slug: 'telegram',
    steps: [
      'Open Telegram. Start a chat with @BotFather',
      <>Send <code className="bg-primary/10 text-primary px-1 rounded font-mono text-[0.9em]">/newbot</code> to @BotFather</>,
      'Pick a name and username ending in "bot"',
      'Copy your bot token from @BotFather and paste it in the form',
      <>Start a chat with your new bot in Telegram and send <code className="bg-primary/10 text-primary px-1 rounded font-mono text-[0.9em]">/start</code></>,
    ],
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: '123456789:ABCdefGHIjklMNO...', type: 'password' as const },
      { key: 'chatId', label: 'Chat ID', placeholder: 'Auto-detected on first message', type: 'text' as const, optional: true },
    ],
  },
  slack: {
    label: 'Slack',
    slug: 'slack',
    steps: [
      <>Open <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline text-primary hover:text-primary/80">api.slack.com/apps</a> → Create New App → From scratch → Select your workspace</>,
      'Settings → Socket Mode → Toggle ON',
      'Basic Information → Scroll to App-Level Tokens → Click Generate Tokens and Scopes',
      'Name your token → Click Add Scope → Select connections:write → Click Generate → Copy the xapp-… token → Paste in the App-Level Token field in the setup form',
      'OAuth & Permissions → Scopes → Bot Token Scopes → Add: chat:write, im:history, im:read, im:write, channels:history, channels:read, groups:history, groups:read, mpim:history, mpim:read, users:read, files:read, files:write, reactions:write',
      'Event Subscriptions → Toggle ON → Subscribe to bot events → Add: message.im, message.channels, message.groups, message.mpim',
      'Interactivity & Shortcuts → Toggle ON',
      'App Home → Show Tabs → Check "Messages Tab" and "Allow users to send Slash commands and messages from the messages tab"',
      <>OAuth &amp; Permissions → Under OAuth Tokens → Click Install to {'{'}<em>workspace name</em>{'}'}</>,
      'Copy Bot Token (xoxb-…) → Paste into Bot Token form field',
    ],
    fields: [
      { key: 'appToken', label: 'App-Level Token', placeholder: 'xapp-...', type: 'password' as const },
      { key: 'botToken', label: 'Bot Token', placeholder: 'xoxb-...', type: 'password' as const },
      { key: 'channelId', label: 'Channel ID', placeholder: 'Auto-detected from DMs', type: 'text' as const, optional: true },
    ],
  },
  imessage: {
    label: 'iMessage',
    slug: 'imessage',
    steps: [
      <>Text <code className="bg-primary/10 text-primary px-1 rounded font-mono text-[0.9em]">/setup</code> to <PhoneNumberCopyButton /> from the phone number you want to connect</>,
      'You\'ll receive a reply with a 6-digit code (expires in 15 minutes)',
      'Enter your phone number and the code below',
      <>Text <code className="bg-primary/10 text-primary px-1 rounded font-mono text-[0.9em]">/setup</code> to the same number at any time to get a new code</>,
    ],
    note: <><strong className="font-medium">Note:</strong> Only one agent can be connected to iMessage. We recommend setting up a dedicated agent for iMessage that can communicate with all of your other agents.</>,
    fields: [
      { key: 'phoneNumber', label: 'Your Phone Number', placeholder: '+15551234567 (E.164 format)', type: 'text' as const },
      { key: 'code', label: 'Setup Code', placeholder: '6-digit code from iMessage', type: 'text' as const },
    ],
  },
}

interface ChatIntegrationSetupDialogProps {
  agentSlug: string
  /** Non-null opens the dialog for that provider; null is closed. */
  provider: ChatProvider | null
  onOpenChange: (open: boolean) => void
}

export function ChatIntegrationSetupDialog({
  agentSlug,
  provider,
  onOpenChange,
}: ChatIntegrationSetupDialogProps) {
  return (
    <Dialog open={!!provider} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden">
        {provider && (
          <SetupForm
            key={provider}
            agentSlug={agentSlug}
            provider={provider}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function SetupForm({
  agentSlug,
  provider,
  onClose,
}: {
  agentSlug: string
  provider: ChatProvider
  onClose: () => void
}) {
  const createIntegration = useCreateChatIntegration()
  const testCredentials = useTestChatIntegrationCredentials()

  const [formData, setFormData] = useState<Record<string, string>>({})
  const [integrationName, setIntegrationName] = useState('')
  const [showToolCalls, setShowToolCalls] = useState(false)
  const [sessionTimeout, setSessionTimeout] = useState('')
  const [onlyMentioned, setOnlyMentioned] = useState(false)
  const [answerInThread, setAnswerInThread] = useState(false)
  const [newSessionPerThread, setNewSessionPerThread] = useState(false)
  const [testResult, setTestResult] = useState<{ valid: boolean; info?: string } | null>(null)
  const [slackSetupMode, setSlackSetupMode] = useState<'manifest' | 'manual'>('manifest')
  const [manifestCopied, setManifestCopied] = useState(false)
  const [manifestPreview, setManifestPreview] = useState(false)

  const info = PROVIDER_INFO[provider]

  // Returns an error message string when required fields are missing, else null.
  const validateRequired = (): string | null => {
    const missingRequired = info.fields.some((f) => !f.optional && !formData[f.key]?.trim())
    if (!missingRequired) return null
    if (provider === 'slack') return 'Please enter the bot and app tokens first.'
    if (provider === 'telegram') return 'Please enter the bot token first.'
    return 'Please enter your phone number and setup code first.'
  }

  const handleTest = async () => {
    setTestResult(null)
    const missing = validateRequired()
    if (missing) {
      setTestResult({ valid: false, info: missing })
      return
    }
    try {
      const result = await testCredentials.mutateAsync({ provider, config: formData })
      const detail = provider === 'telegram'
        ? `Bot: @${result.botUsername || result.botName}`
        : provider === 'slack'
        ? `Workspace: ${result.team}`
        : `Connected: ${result.phoneNumber || 'OK'}`
      setTestResult({ valid: true, info: detail })
    } catch (err) {
      setTestResult({ valid: false, info: err instanceof Error ? err.message : 'Invalid credentials' })
    }
  }

  const handleCreate = async () => {
    const missing = validateRequired()
    if (missing) {
      setTestResult({ valid: false, info: missing })
      return
    }
    try {
      const config: Record<string, unknown> = { ...formData }
      if (provider === 'slack') {
        if (onlyMentioned) config.onlyMentioned = true
        if (answerInThread) config.answerInThread = true
        if (answerInThread && newSessionPerThread) config.newSessionPerThread = true
      }
      if (provider === 'imessage') {
        config.gatewayUrl = 'https://imsgw.com'
      }
      const parsedTimeout = parseInt(sessionTimeout, 10)
      await createIntegration.mutateAsync({
        agentSlug,
        provider,
        name: integrationName.trim() || undefined,
        config,
        showToolCalls,
        sessionTimeout: parsedTimeout > 0 ? parsedTimeout : null,
      })
      onClose()
    } catch {
      // Error surfaced via createIntegration.error
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 font-normal">
          <ServiceIcon slug={info.slug} fallback="mcp" className="h-5 w-5" />
          Set up remote chat with {info.label}
        </DialogTitle>
      </DialogHeader>

      <div className="flex flex-col md:flex-row gap-6 p-1">
        {/* Left — setup instructions */}
        <div className="md:w-[55%] flex flex-col justify-center gap-4 max-h-[60vh] overflow-y-auto">
        {provider === 'slack' && slackSetupMode === 'manifest' ? (
          <div className="space-y-3">
            <ol className="list-decimal list-outside ml-5 space-y-2.5">
              <li className="text-sm font-normal text-foreground">
                Open <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline text-primary hover:text-primary/80">api.slack.com/apps</a>
              </li>
              <li className="text-sm font-normal text-foreground">
                Create New App → From an app manifest → Select your workspace
              </li>
              <li className="text-sm font-normal text-foreground">
                Copy manifest below. Paste to replace manifest in Slack.
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={async () => {
                      await navigator.clipboard.writeText(generateSlackManifest(integrationName.trim() || 'Gamut Bot'))
                      setManifestCopied(true)
                      setTimeout(() => setManifestCopied(false), 2000)
                    }}
                  >
                    {manifestCopied ? <><Check className="h-3 w-3 mr-1" /> Copied</> : <><Copy className="h-3 w-3 mr-1" /> Copy Manifest</>}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setManifestPreview(!manifestPreview)}
                  >
                    {manifestPreview ? <><EyeOff className="h-3 w-3 mr-1" /> Hide Manifest</> : <><Eye className="h-3 w-3 mr-1" /> Preview Manifest</>}
                  </Button>
                </div>
                {manifestPreview && (
                  <pre className="mt-2 text-2xs leading-relaxed bg-background border rounded-md p-2 overflow-x-auto max-h-40 select-all">
                    {generateSlackManifest(integrationName.trim() || 'Gamut Bot')}
                  </pre>
                )}
              </li>
              <li className="text-sm font-normal text-foreground">In Basic Information section → Scroll to App-Level Tokens → Click Generate Tokens and Scopes</li>
              <li className="text-sm font-normal text-foreground">Name your token → Click Add Scope → Select connections:write → Click Generate</li>
              <li className="text-sm font-normal text-foreground">Copy the token → Paste in the App-Level Token field in the setup form</li>
              <li className="text-sm font-normal text-foreground">In OAuth &amp; Permissions section → Under OAuth Tokens → Click Install to {'{'}<em>workspace name</em>{'}'}</li>
              <li className="text-sm font-normal text-foreground">Copy Bot Token → Paste into Bot Token form field</li>
            </ol>
            <p className="pt-4 text-xs text-muted-foreground">
              Prefer more control?{' '}
              <button
                type="button"
                className="underline text-primary hover:text-primary/80"
                onClick={() => setSlackSetupMode('manual')}
              >
                Go to manual setup
              </button>
            </p>
          </div>
        ) : provider === 'slack' ? (
          <div className="space-y-3">
            <ol className="list-decimal list-outside ml-5 space-y-2.5">
              {info.steps.map((step, i) => (
                <li key={i} className="text-sm font-normal text-foreground">{step}</li>
              ))}
            </ol>
            <p className="pt-4 text-xs text-muted-foreground">
              <button
                type="button"
                className="underline text-primary hover:text-primary/80"
                onClick={() => setSlackSetupMode('manifest')}
              >
                Switch back to quick setup
              </button>
            </p>
          </div>
        ) : (
          <div>
            <ol className="list-decimal list-outside ml-5 space-y-2.5">
              {info.steps.map((step, i) => (
                <li key={i} className="text-sm font-normal text-foreground">{step}</li>
              ))}
            </ol>
          </div>
        )}
        {info.note && (
          <div className="rounded-md border border-amber-300/60 bg-amber-100/70 dark:border-amber-700/50 dark:bg-amber-950/40 p-3">
            <p className="text-xs text-amber-900 dark:text-amber-200 leading-relaxed">{info.note}</p>
          </div>
        )}
        </div>

        {/* Right — credentials + actions */}
        <div className="md:w-[45%] rounded-lg border bg-muted/40 shadow-md flex flex-col max-h-[60vh]">
        <div className="flex flex-col gap-4 overflow-y-auto p-4 flex-1 min-h-0">
        <div className="space-y-3">
          <div>
            <Label className="text-xs font-normal">
              Bot Name
            </Label>
            <Input
              value={integrationName}
              onChange={(e) => setIntegrationName(e.target.value)}
              placeholder={`My ${info.label} Bot`}
              className="mt-1 shadow-none bg-background"
            />
          </div>

          {info.fields.map((field) => (
            <div key={field.key}>
              <Label className="text-xs font-normal">
                {field.label}
                {field.optional && <span className="ml-1 font-normal text-muted-foreground/70">optional</span>}
              </Label>
              <Input
                type={field.type}
                value={formData[field.key] || ''}
                onChange={(e) => setFormData({ ...formData, [field.key]: e.target.value })}
                placeholder={field.placeholder}
                className="mt-1 shadow-none bg-background"
              />
            </div>
          ))}

          <div className={`${provider === 'slack' ? 'pt-6' : 'pt-4'} space-y-3`}>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="setup-show-tool-calls" className="text-xs font-normal cursor-pointer">
                Show tool calls in chat
              </Label>
              <Switch
                id="setup-show-tool-calls"
                checked={showToolCalls}
                onCheckedChange={setShowToolCalls}
              />
            </div>

            <div>
              <Label htmlFor="setup-session-timeout" className="text-xs font-normal">
                New session after
                <span className="ml-1 font-normal text-muted-foreground/70">hours, blank = never</span>
              </Label>
              <Input
                id="setup-session-timeout"
                type="number"
                min="1"
                step="1"
                value={sessionTimeout}
                onChange={(e) => setSessionTimeout(e.target.value)}
                placeholder="Never (single session)"
                className="mt-1 shadow-none bg-background"
              />
            </div>

            {provider === 'slack' && (
              <>
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="setup-only-mentioned" className="text-xs font-normal cursor-pointer">
                    Only trigger on @mention
                  </Label>
                  <Switch
                    id="setup-only-mentioned"
                    checked={onlyMentioned}
                    onCheckedChange={setOnlyMentioned}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="setup-answer-thread" className="text-xs font-normal cursor-pointer">
                    Reply in thread
                  </Label>
                  <Switch
                    id="setup-answer-thread"
                    checked={answerInThread}
                    onCheckedChange={(checked) => {
                      setAnswerInThread(checked)
                      if (!checked) setNewSessionPerThread(false)
                    }}
                  />
                </div>
                {answerInThread && (
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="setup-session-per-thread" className="text-xs font-normal cursor-pointer">
                      New session per thread
                    </Label>
                    <Switch
                      id="setup-session-per-thread"
                      checked={newSessionPerThread}
                      onCheckedChange={setNewSessionPerThread}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>

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
              ? provider === 'imessage'
                ? 'This phone number is already connected to another integration. Remove the existing one first.'
                : 'This bot is already connected to another integration. Remove the existing one first, or use a different bot.'
              : createIntegration.error.message}
          </p>
        )}

        </div>
        <div className="flex items-center justify-end gap-2 p-4">
          {provider !== 'imessage' && (
            <Button
              size="sm"
              variant="ghost"
              className="mr-auto"
              onClick={handleTest}
              disabled={testCredentials.isPending}
            >
              {testCredentials.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Verifying...</>
              ) : (
                'Verify token'
              )}
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={createIntegration.isPending}
          >
            {createIntegration.isPending ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Connecting...</>
            ) : (
              'Connect'
            )}
          </Button>
        </div>
        </div>
      </div>
    </>
  )
}
