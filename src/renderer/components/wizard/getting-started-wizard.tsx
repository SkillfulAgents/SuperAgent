import { useState, useMemo, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { useSettings, useUpdateSettings, useStartRunner } from '@renderer/hooks/use-settings'
import { useCreateAgent } from '@renderer/hooks/use-agents'
import { useSelection } from '@renderer/context/selection-context'
import { apiFetch } from '@renderer/lib/api'
import { AnthropicApiKeyInput } from '@renderer/components/settings/anthropic-api-key-input'
import {
  Eye,
  EyeOff,
  Loader2,
  Check,
  Play,
  ExternalLink,
  ChevronRight,
  ChevronLeft,
  Plus,
  Trash2,
} from 'lucide-react'
import {
  useConnectedAccounts,
  useInitiateConnection,
  useDeleteConnectedAccount,
  useInvalidateConnectedAccounts,
} from '@renderer/hooks/use-connected-accounts'
import { useQuery } from '@tanstack/react-query'
import type { Provider } from '@shared/lib/composio/providers'

const STEPS = [
  { label: 'Welcome' },
  { label: 'LLM' },
  { label: 'Docker' },
  { label: 'Composio' },
  { label: 'Agent' },
]

interface GettingStartedWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function GettingStartedWizard({ open, onOpenChange }: GettingStartedWizardProps) {
  const [currentStep, setCurrentStep] = useState(0)
  const updateSettings = useUpdateSettings()

  // Reset step when dialog opens
  useEffect(() => {
    if (open) {
      setCurrentStep(0)
    }
  }, [open])

  const handleFinish = async () => {
    await updateSettings.mutateAsync({ app: { setupCompleted: true } })
    onOpenChange(false)
  }

  const isLastStep = currentStep === STEPS.length - 1

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] p-0 gap-0 [&>button]:hidden" data-testid="wizard-dialog" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogTitle className="sr-only">Getting Started</DialogTitle>
        <DialogDescription className="sr-only">
          Set up Superagent for the first time
        </DialogDescription>

        {/* Progress indicator */}
        <div className="flex items-center justify-center gap-0 px-8 pt-6 pb-2">
          {STEPS.map((step, i) => (
            <div key={i} className="flex items-center">
              <div className="flex flex-col items-center">
                <div
                  className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-medium border-2 transition-colors ${
                    i < currentStep
                      ? 'bg-primary border-primary text-primary-foreground'
                      : i === currentStep
                        ? 'border-primary text-primary bg-primary/10'
                        : 'border-muted-foreground/30 text-muted-foreground'
                  }`}
                >
                  {i < currentStep ? <Check className="h-4 w-4" /> : i + 1}
                </div>
                <span className={`text-[10px] mt-1 ${i === currentStep ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                  {step.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={`w-12 h-0.5 mx-1 mb-4 ${
                    i < currentStep ? 'bg-primary' : 'bg-muted-foreground/30'
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="px-6 py-4 min-h-[320px]" data-testid="wizard-step-content" data-step={currentStep}>
          {currentStep === 0 && <WelcomeStep />}
          {currentStep === 1 && <ConfigureLLMStep />}
          {currentStep === 2 && <DockerSetupStep />}
          {currentStep === 3 && <ComposioStep />}
          {currentStep === 4 && <CreateAgentStep />}
        </div>

        {/* Navigation buttons */}
        <div className="flex items-center justify-between px-6 py-4 border-t">
          <Button
            variant="outline"
            onClick={() => setCurrentStep((s) => s - 1)}
            disabled={currentStep === 0}
            data-testid="wizard-back"
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            Back
          </Button>

          <div className="flex gap-2">
            {(currentStep === 3 || currentStep === 4) && (
              <Button
                variant="ghost"
                onClick={() => {
                  if (isLastStep) {
                    handleFinish()
                  } else {
                    setCurrentStep((s) => s + 1)
                  }
                }}
                data-testid="wizard-skip"
              >
                Skip
              </Button>
            )}
            {isLastStep ? (
              <Button onClick={handleFinish} data-testid="wizard-finish">
                Finish
              </Button>
            ) : (
              <Button onClick={() => setCurrentStep((s) => s + 1)} data-testid="wizard-next">
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function WelcomeStep() {
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Welcome to Superagent</h2>
      <p className="text-muted-foreground">
        Superagent lets you create and manage AI agents that run in isolated Docker containers.
        Each agent has its own environment, tools, and can connect to external services.
      </p>
      <div className="space-y-3 pt-2">
        <p className="text-sm font-medium">This wizard will help you set up:</p>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="font-mono text-primary mt-0.5">1.</span>
            <span><strong>LLM Provider</strong> - Configure your AI model API key</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-mono text-primary mt-0.5">2.</span>
            <span><strong>Docker Runtime</strong> - Ensure containers can run on your machine</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-mono text-primary mt-0.5">3.</span>
            <span><strong>Composio</strong> (optional) - Connect OAuth accounts like Gmail, Slack, GitHub</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="font-mono text-primary mt-0.5">4.</span>
            <span><strong>First Agent</strong> (optional) - Create your first AI agent</span>
          </li>
        </ul>
      </div>
      <p className="text-sm text-muted-foreground pt-2">
        You can always change these settings later. Click <strong>Next</strong> to get started.
      </p>
    </div>
  )
}

function ConfigureLLMStep() {
  const [showInstructions, setShowInstructions] = useState(false)

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Configure LLM Provider</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Superagent needs an API key to communicate with AI models.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Provider</Label>
        <div className="flex items-center gap-2 p-2 rounded-md border bg-muted/30">
          <span className="text-sm font-medium">Anthropic (Claude)</span>
          <span className="text-xs text-muted-foreground ml-auto">Only supported provider</span>
        </div>
      </div>

      <AnthropicApiKeyInput
        idPrefix="wizard-api-key"
        showNotConfiguredAlert={false}
        showHelpText={false}
        showRemoveButton={false}
      />

      <div className="pt-2">
        <button
          type="button"
          onClick={() => setShowInstructions(!showInstructions)}
          className="text-sm text-primary hover:underline flex items-center gap-1"
        >
          <ChevronRight className={`h-3 w-3 transition-transform ${showInstructions ? 'rotate-90' : ''}`} />
          How to get an API key
        </button>

        {showInstructions && (
          <div className="mt-2 p-3 rounded-md border bg-muted/30 text-sm space-y-2">
            <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground">
              <li>
                Sign up for an account at{' '}
                <a
                  href="https://console.anthropic.com/login"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-4"
                >
                  console.anthropic.com
                </a>
              </li>
              <li>Click your Profile in the top right corner and select <strong>API Keys</strong></li>
              <li>Click <strong>Create Key</strong>, name your key, and hit <strong>Create Key</strong></li>
            </ol>
          </div>
        )}
      </div>
    </div>
  )
}

function DockerSetupStep() {
  const { data: settings } = useSettings()
  const startRunner = useStartRunner()

  const runtimeStatuses = useMemo(() => {
    if (!settings?.runnerAvailability) return []
    return settings.runnerAvailability.map((r) => ({
      ...r,
      info: RUNTIME_INFO[r.runner as keyof typeof RUNTIME_INFO],
    }))
  }, [settings?.runnerAvailability])

  const hasAvailableRunner = useMemo(() => {
    return settings?.runnerAvailability?.some((r) => r.available) ?? false
  }, [settings?.runnerAvailability])

  const handleStartRunner = async (runner: 'docker' | 'podman') => {
    try {
      await startRunner.mutateAsync(runner)
    } catch (error) {
      console.error('Failed to start runner:', error)
    }
  }

  const handleOpenInstallLink = (url: string) => {
    if (window.electronAPI) {
      window.electronAPI.openExternal(url)
    } else {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Set Up Docker Runtime</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Superagent runs AI agents in isolated containers. You need Docker or Podman installed and running.
        </p>
      </div>

      {hasAvailableRunner && (
        <Alert>
          <Check className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-700 dark:text-green-400">
            Container runtime is available. You&apos;re good to go!
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-3">
        {runtimeStatuses.map((runtime) => (
          <div
            key={runtime.runner}
            className="flex items-start gap-3 p-3 rounded-lg border bg-card"
          >
            <span className="text-2xl">{runtime.info.icon}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">{runtime.info.name}</span>
                {runtime.available && (
                  <span className="text-xs bg-green-500/10 text-green-600 dark:text-green-400 px-2 py-0.5 rounded-full flex items-center gap-1">
                    <Check className="h-3 w-3" />
                    Running
                  </span>
                )}
                {runtime.installed && !runtime.running && (
                  <span className="text-xs bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 px-2 py-0.5 rounded-full">
                    Installed (not running)
                  </span>
                )}
                {!runtime.installed && (
                  <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full">
                    Not installed
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {runtime.info.description}
              </p>
              <div className="mt-2">
                {runtime.available ? (
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled>
                    <Check className="h-3 w-3 mr-1" />
                    Ready to use
                  </Button>
                ) : runtime.installed && runtime.canStart ? (
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleStartRunner(runtime.runner as 'docker' | 'podman')}
                    disabled={startRunner.isPending}
                  >
                    {startRunner.isPending ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <Play className="h-3 w-3 mr-1" />
                    )}
                    Start {runtime.info.name}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => handleOpenInstallLink(runtime.info.installUrl)}
                  >
                    <ExternalLink className="h-3 w-3 mr-1" />
                    Install {runtime.info.name}
                  </Button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {startRunner.error && (
        <p className="text-sm text-destructive">{startRunner.error.message}</p>
      )}

      {startRunner.isSuccess && startRunner.data?.message && (
        <p className="text-sm text-green-600 dark:text-green-400">
          {startRunner.data.message}
        </p>
      )}
    </div>
  )
}

const RUNTIME_INFO = {
  docker: {
    name: 'Docker Desktop',
    description: 'The most popular container runtime. Easy to use with a graphical interface.',
    installUrl: 'https://www.docker.com/products/docker-desktop/',
    icon: '🐳',
  },
  podman: {
    name: 'Podman',
    description: 'A lightweight, daemonless container engine. Great alternative to Docker.',
    installUrl: 'https://podman.io/getting-started/installation',
    icon: '🦭',
  },
}

function ComposioStep() {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()

  const [composioApiKeyInput, setComposioApiKeyInput] = useState('')
  const [composioUserIdInput, setComposioUserIdInput] = useState('')
  const [showComposioApiKey, setShowComposioApiKey] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  const composioApiKeyStatus = settings?.apiKeyStatus?.composio
  const hasComposioUserId = !!settings?.composioUserId
  const isComposioConfigured = composioApiKeyStatus?.isConfigured && hasComposioUserId

  const handleSave = async () => {
    if (!composioApiKeyInput.trim() && !composioUserIdInput.trim()) return
    setIsSaving(true)
    try {
      const updates: { composioApiKey?: string; composioUserId?: string } = {}
      if (composioApiKeyInput.trim()) updates.composioApiKey = composioApiKeyInput.trim()
      if (composioUserIdInput.trim()) updates.composioUserId = composioUserIdInput.trim()
      await updateSettings.mutateAsync({ apiKeys: updates })
      setComposioApiKeyInput('')
      setComposioUserIdInput('')
      setShowComposioApiKey(false)
    } catch (error) {
      console.error('Failed to save Composio settings:', error)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Set Up Composio</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Composio lets your agents connect to external services via OAuth (Gmail, Slack, GitHub, etc.).
          This step is optional.
        </p>
      </div>

      {isComposioConfigured && (
        <Alert>
          <Check className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-700 dark:text-green-400">
            Composio is configured. You can connect accounts below or skip to the next step.
          </AlertDescription>
        </Alert>
      )}

      {!isComposioConfigured && (
        <>
          <div className="space-y-2">
            <Label htmlFor="wizard-composio-key">Composio API Key</Label>
            <div className="relative">
              <Input
                id="wizard-composio-key"
                type={showComposioApiKey ? 'text' : 'password'}
                value={composioApiKeyInput}
                onChange={(e) => setComposioApiKeyInput(e.target.value)}
                placeholder={composioApiKeyStatus?.isConfigured ? '••••••••••••••••' : 'Enter Composio API key'}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowComposioApiKey(!showComposioApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showComposioApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Get your API key from{' '}
              <a
                href="https://app.composio.dev/settings"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-4"
              >
                Composio Dashboard
              </a>
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="wizard-composio-userid">Composio User ID</Label>
            <Input
              id="wizard-composio-userid"
              type="text"
              value={composioUserIdInput}
              onChange={(e) => setComposioUserIdInput(e.target.value)}
              placeholder="Enter your Composio user ID (e.g., your email)"
            />
            <p className="text-xs text-muted-foreground">
              Your unique identifier in Composio. Can be any string.
            </p>
          </div>

          {(composioApiKeyInput.trim() || composioUserIdInput.trim()) && (
            <Button size="sm" onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save Composio Settings'}
            </Button>
          )}
        </>
      )}

      {isComposioConfigured && <WizardConnectedAccounts />}
    </div>
  )
}

function WizardConnectedAccounts() {
  const { data: accountsData, isLoading: isLoadingAccounts } = useConnectedAccounts()
  const { data: providersData } = useQuery<{ providers: Provider[] }>({
    queryKey: ['providers'],
    queryFn: async () => {
      const res = await apiFetch('/api/providers')
      if (!res.ok) throw new Error('Failed to fetch providers')
      return res.json()
    },
  })
  const initiateConnection = useInitiateConnection()
  const deleteAccount = useDeleteConnectedAccount()
  const invalidateAccounts = useInvalidateConnectedAccounts()

  const [connectingProvider, setConnectingProvider] = useState<string | null>(null)
  const [deletingAccount, setDeletingAccount] = useState<string | null>(null)

  useEffect(() => {
    const handleOAuthComplete = (success: boolean) => {
      setConnectingProvider(null)
      if (success) invalidateAccounts()
    }

    if (window.electronAPI) {
      window.electronAPI.onOAuthCallback(async (params) => {
        if (params.error || params.status === 'failed') {
          handleOAuthComplete(false)
          return
        }
        if (params.connectionId && params.toolkit) {
          try {
            const res = await apiFetch('/api/connected-accounts/complete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                connectionId: params.connectionId,
                toolkit: params.toolkit,
              }),
            })
            handleOAuthComplete(res.ok)
          } catch {
            handleOAuthComplete(false)
          }
        } else {
          handleOAuthComplete(false)
        }
      })
      return () => {
        window.electronAPI?.removeOAuthCallback()
      }
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'oauth-callback') {
        handleOAuthComplete(event.data.success)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [invalidateAccounts])

  const handleConnect = async (providerSlug: string) => {
    setConnectingProvider(providerSlug)
    try {
      const isElectronApp = !!window.electronAPI
      const result = await initiateConnection.mutateAsync({ providerSlug, electron: isElectronApp })
      if (window.electronAPI) {
        await window.electronAPI.openExternal(result.redirectUrl)
      } else {
        window.open(result.redirectUrl, '_blank')
      }
    } catch {
      setConnectingProvider(null)
    }
  }

  const handleDelete = async (accountId: string) => {
    setDeletingAccount(accountId)
    try {
      await deleteAccount.mutateAsync(accountId)
    } catch {
      // ignore
    } finally {
      setDeletingAccount(null)
    }
  }

  const accounts = accountsData?.accounts || []
  const providers = providersData?.providers || []

  return (
    <div className="space-y-3 pt-2 border-t">
      <Label>Connected Accounts</Label>

      {isLoadingAccounts ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading accounts...
        </div>
      ) : accounts.length > 0 ? (
        <div className="space-y-2">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="flex items-center justify-between p-2 rounded-md border bg-muted/30"
            >
              <div className="flex items-center gap-2">
                <ExternalLink className="h-3 w-3 text-muted-foreground" />
                <span className="text-sm">{account.displayName}</span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={() => handleDelete(account.id)}
                disabled={deletingAccount === account.id}
              >
                {deletingAccount === account.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3 text-destructive" />
                )}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No accounts connected yet.</p>
      )}

      <div className="grid grid-cols-2 gap-2">
        {providers.map((provider) => (
          <Button
            key={provider.slug}
            variant="outline"
            size="sm"
            className="justify-start text-xs"
            onClick={() => handleConnect(provider.slug)}
            disabled={connectingProvider !== null}
          >
            {connectingProvider === provider.slug ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Plus className="h-3 w-3 mr-1" />
            )}
            {provider.displayName}
          </Button>
        ))}
      </div>
    </div>
  )
}

function CreateAgentStep() {
  const [name, setName] = useState('')
  const [created, setCreated] = useState(false)
  const createAgent = useCreateAgent()
  const { selectAgent } = useSelection()

  const handleCreate = async () => {
    if (!name.trim()) return
    try {
      const newAgent = await createAgent.mutateAsync({ name: name.trim() })
      selectAgent(newAgent.slug)
      setCreated(true)
    } catch (error) {
      console.error('Failed to create agent:', error)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Create Your First Agent</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Create an AI agent to get started. Each agent runs in its own container and can be customized with instructions and tools.
          This step is optional.
        </p>
      </div>

      {created ? (
        <Alert>
          <Check className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-700 dark:text-green-400">
            Agent created successfully! Click <strong>Finish</strong> to start using Superagent.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="wizard-agent-name">Agent Name</Label>
            <Input
              id="wizard-agent-name"
              placeholder="My First Agent"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
              }}
              data-testid="wizard-agent-name-input"
            />
          </div>

          <Button
            onClick={handleCreate}
            disabled={!name.trim() || createAgent.isPending}
            data-testid="wizard-create-agent"
          >
            {createAgent.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              'Create Agent'
            )}
          </Button>
        </div>
      )}
    </div>
  )
}
