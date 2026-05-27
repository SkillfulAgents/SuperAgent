import { useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useUser } from '@renderer/context/user-context'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { ComposioApiKeyInput } from '@renderer/components/settings/composio-api-key-input'
import { ProviderApiKeyInput } from '@renderer/components/settings/provider-api-key-input'
import type { AccountProviderType } from '@shared/lib/config/settings'

const ACCOUNT_PROVIDERS: Array<{
  value: AccountProviderType
  label: string
  description: string
}> = [
  {
    value: 'composio',
    label: 'Composio',
    description: 'Composio-managed OAuth connections',
  },
  {
    value: 'nango',
    label: 'Nango',
    description: 'Self-hosted or cloud Nango connections',
  },
]

export function AccountProviderTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const { isAuthMode, user } = useUser()
  const { data: platformAuth } = usePlatformAuthStatus()
  const isPlatformConnected = platformAuth?.connected ?? false

  const [userIdInput, setUserIdInput] = useState('')
  const [isSavingUserId, setIsSavingUserId] = useState(false)

  const activeProvider: AccountProviderType = settings?.app?.accountProvider ?? 'composio'
  const hasUserId = isAuthMode ? !!user?.id : !!settings?.accountProviderUserId
  const hasLocalComposioKey = settings?.apiKeyStatus?.composio?.isConfigured ?? false

  const handleSaveUserId = async () => {
    if (isAuthMode || !userIdInput.trim()) return
    setIsSavingUserId(true)
    try {
      await updateSettings.mutateAsync({
        apiKeys: { accountProviderUserId: userIdInput.trim() },
      })
      setUserIdInput('')
    } catch (error) {
      console.error('Failed to save user ID:', error)
    } finally {
      setIsSavingUserId(false)
    }
  }

  const handleRemoveUserId = async () => {
    setIsSavingUserId(true)
    try {
      await updateSettings.mutateAsync({
        apiKeys: { accountProviderUserId: '' },
      })
    } catch (error) {
      console.error('Failed to remove user ID:', error)
    } finally {
      setIsSavingUserId(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium">Account Provider</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Choose which service manages OAuth connections (Gmail, Slack, GitHub, etc.).
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="account-provider">Provider</Label>
        <Select
          value={activeProvider}
          onValueChange={(value) => {
            updateSettings.mutateAsync({ app: { accountProvider: value as AccountProviderType } })
              .catch((err) => console.error('Failed to save account provider:', err))
          }}
          disabled={isLoading}
        >
          <SelectTrigger id="account-provider">
            <SelectValue placeholder="Select a provider" />
          </SelectTrigger>
          <SelectContent>
            {ACCOUNT_PROVIDERS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
                <span className="text-muted-foreground ml-2">({p.description})</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Switching providers requires reconnecting your OAuth accounts.
        </p>
      </div>

      {/* Provider-specific configuration */}
      {activeProvider === 'composio' && (
        <>
          {isPlatformConnected && (
            <div className={`rounded-md border px-3 py-2 ${
              hasLocalComposioKey
                ? 'border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-500/10'
                : 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-500/10'
            }`}>
              {hasLocalComposioKey ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-blue-700 dark:text-blue-400">
                    Using your local Composio API key.
                    Remove the key below to switch to platform-managed Composio.
                  </p>
                  <p className="text-xs text-blue-700 dark:text-blue-400">
                    Webhook triggers are not supported with a personal key.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-green-700 dark:text-green-400">
                  Composio is managed by your organization on the platform.
                  {platformAuth?.orgName && <> ({platformAuth.orgName})</>}
                  {' '}Set your own API key below to use a personal Composio account instead.
                </p>
              )}
            </div>
          )}

          <ComposioApiKeyInput disabled={isLoading} />
        </>
      )}

      {activeProvider === 'nango' && (
        <>
          <ProviderApiKeyInput
            providerId="nango"
            label="Nango Secret Key"
            placeholder="Enter Nango secret key"
            apiKeySettingsField="nangoSecretKey"
            apiKeyStatusKey="nango"
            validationEndpoint="/api/settings/validate-nango-key"
            validationBody={(apiKey) => ({ apiKey })}
            showSourceIndicator
            showNotConfiguredAlert
            showHelpText
            showRemoveButton
            helpText={
              <>
                Find your secret key in the{' '}
                <a
                  href="https://app.nango.dev/dev/environment-settings#api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-4"
                >
                  Nango Dashboard
                </a>
              </>
            }
            disabled={isLoading}
          />
        </>
      )}

      {/* User ID — shared across providers */}
      <div className="space-y-2">
        <Label htmlFor="provider-user-id">User ID</Label>

        {!isAuthMode && hasUserId && (
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
              Configured
            </span>
          </div>
        )}

        <Input
          id="provider-user-id"
          type="text"
          value={isAuthMode ? (user?.id ?? '') : userIdInput}
          onChange={(e) => setUserIdInput(e.target.value)}
          placeholder={hasUserId ? 'Enter new user ID to replace' : 'Enter your user ID'}
          disabled={isAuthMode || isLoading}
        />

        <p className="text-xs text-muted-foreground">
          {isAuthMode
            ? 'Automatically set from your account.'
            : 'Your unique identifier for the account provider. Used to scope OAuth connections to you. Can be any string (e.g., your email).'}
        </p>

        {!isAuthMode && hasUserId && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleRemoveUserId}
            disabled={isSavingUserId}
          >
            {isSavingUserId ? 'Removing...' : 'Remove User ID'}
          </Button>
        )}
      </div>

      {!isAuthMode && userIdInput.trim() && (
        <Button size="sm" onClick={handleSaveUserId} disabled={isSavingUserId}>
          {isSavingUserId ? 'Saving...' : 'Save User ID'}
        </Button>
      )}
    </div>
  )
}
