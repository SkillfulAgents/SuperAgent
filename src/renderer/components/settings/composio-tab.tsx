import { useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useUser } from '@renderer/context/user-context'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { ComposioApiKeyInput } from '@renderer/components/settings/composio-api-key-input'

export function ComposioTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const { isAuthMode, user } = useUser()
  const { data: platformAuth } = usePlatformAuthStatus()
  const isPlatformConnected = platformAuth?.connected ?? false

  const [composioUserIdInput, setComposioUserIdInput] = useState('')
  const [isSavingUserId, setIsSavingUserId] = useState(false)

  const hasComposioUserId = isAuthMode ? !!user?.id : !!settings?.composioUserId

  const handleSaveUserId = async () => {
    if (isAuthMode || !composioUserIdInput.trim()) return
    setIsSavingUserId(true)
    try {
      await updateSettings.mutateAsync({
        apiKeys: { composioUserId: composioUserIdInput.trim() },
      })
      setComposioUserIdInput('')
    } catch (error) {
      console.error('Failed to save Composio user ID:', error)
    } finally {
      setIsSavingUserId(false)
    }
  }

  const handleRemoveComposioUserId = async () => {
    setIsSavingUserId(true)
    try {
      await updateSettings.mutateAsync({
        apiKeys: { composioUserId: '' },
      })
    } catch (error) {
      console.error('Failed to remove Composio user ID:', error)
    } finally {
      setIsSavingUserId(false)
    }
  }

  const hasLocalComposioKey = settings?.apiKeyStatus?.composio?.isConfigured ?? false

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium">Composio Integration</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Configure the Composio account provider for OAuth connections (Gmail, Slack, GitHub, etc.).
        </p>
      </div>

      {isPlatformConnected && (
        <div className={`rounded-md border px-3 py-2 ${
          hasLocalComposioKey
            ? 'border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30'
            : 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30'
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

      {isPlatformConnected && hasLocalComposioKey && (
        <p className="text-xs text-muted-foreground -mt-4">
          Switching provider requires reconnecting your OAuth accounts.
        </p>
      )}

      {/* Composio User ID */}
      <div className="space-y-2">
        <Label htmlFor="composio-user-id">Composio User ID</Label>

        {/* Current value indicator */}
        {!isAuthMode && hasComposioUserId && (
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
              Configured
            </span>
          </div>
        )}

        <Input
          id="composio-user-id"
          type="text"
          value={isAuthMode ? (user?.id ?? '') : composioUserIdInput}
          onChange={(e) => setComposioUserIdInput(e.target.value)}
          placeholder={hasComposioUserId ? 'Enter new user ID to replace' : 'Enter your Composio user ID'}
          disabled={isAuthMode || isLoading}
        />

        <p className="text-xs text-muted-foreground">
          {isAuthMode
            ? 'Automatically set from your account.'
            : 'Your unique identifier in Composio. Can be any string (e.g., your email).'}
        </p>

        {/* Remove button */}
        {!isAuthMode && hasComposioUserId && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleRemoveComposioUserId}
            disabled={isSavingUserId}
          >
            {isSavingUserId ? 'Removing...' : 'Remove User ID'}
          </Button>
        )}
      </div>

      {/* Save button for User ID */}
      {!isAuthMode && composioUserIdInput.trim() && (
        <Button size="sm" onClick={handleSaveUserId} disabled={isSavingUserId}>
          {isSavingUserId ? 'Saving...' : 'Save User ID'}
        </Button>
      )}

    </div>
  )
}
