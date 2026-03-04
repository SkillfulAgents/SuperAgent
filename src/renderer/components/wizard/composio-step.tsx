import { useState, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { apiFetch } from '@renderer/lib/api'
import { ComposioApiKeyInput } from '@renderer/components/settings/composio-api-key-input'
import {
  Loader2,
  Check,
  ExternalLink,
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
import { useUser } from '@renderer/context/user-context'

export interface ComposioStepProps {
  onCanProceedChange: (canProceed: boolean) => void
  saveRef: { current: (() => Promise<void>) | null }
}

export function ComposioStep({ onCanProceedChange, saveRef }: ComposioStepProps) {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()
  const { isAuthMode, user } = useUser()

  const [composioUserIdInput, setComposioUserIdInput] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const composioApiKeyStatus = settings?.apiKeyStatus?.composio
  // In auth mode, user ID is automatic (from the logged-in user)
  const hasComposioUserId = isAuthMode ? !!user?.id : !!settings?.composioUserId
  const isComposioConfigured = composioApiKeyStatus?.isConfigured && hasComposioUserId
  const hasUserIdInput = !isAuthMode && !!composioUserIdInput.trim()

  useEffect(() => {
    onCanProceedChange(!!(isComposioConfigured || hasUserIdInput) && !isSaving)
  }, [isComposioConfigured, hasUserIdInput, isSaving, onCanProceedChange])

  const handleSaveUserId = async () => {
    if (isAuthMode || !composioUserIdInput.trim()) return
    setIsSaving(true)
    try {
      await updateSettings.mutateAsync({ apiKeys: { composioUserId: composioUserIdInput.trim() } })
      setComposioUserIdInput('')
    } finally {
      setIsSaving(false)
    }
  }

  // Keep save ref in sync for parent to call on Next
  saveRef.current = (hasUserIdInput && !isComposioConfigured) ? handleSaveUserId : null

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
          <ComposioApiKeyInput
            idPrefix="wizard-composio-key"
            showRemoveButton={false}
            showSourceIndicator={false}
          />

          <div className="space-y-2">
            <Label htmlFor="wizard-composio-userid">Composio User ID</Label>
            <Input
              id="wizard-composio-userid"
              type="text"
              value={isAuthMode ? (user?.id ?? '') : composioUserIdInput}
              onChange={(e) => setComposioUserIdInput(e.target.value)}
              placeholder="Enter your Composio user ID (e.g., your email)"
              disabled={isAuthMode}
            />
            <p className="text-xs text-muted-foreground">
              {isAuthMode
                ? 'Automatically set from your account.'
                : 'Your unique identifier in Composio. Can be any string.'}
            </p>
          </div>
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
