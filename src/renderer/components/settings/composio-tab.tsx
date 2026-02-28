import { useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { Eye, EyeOff } from 'lucide-react'

export function ComposioTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()

  // Composio settings state
  const [composioApiKeyInput, setComposioApiKeyInput] = useState('')
  const [showComposioApiKey, setShowComposioApiKey] = useState(false)
  const [composioUserIdInput, setComposioUserIdInput] = useState('')
  const [isSavingComposio, setIsSavingComposio] = useState(false)

  const composioApiKeyStatus = settings?.apiKeyStatus?.composio
  const hasComposioUserId = !!settings?.composioUserId

  const handleSaveComposioSettings = async () => {
    setIsSavingComposio(true)
    try {
      const updates: { composioApiKey?: string; composioUserId?: string } = {}
      if (composioApiKeyInput.trim()) {
        updates.composioApiKey = composioApiKeyInput.trim()
      }
      if (composioUserIdInput.trim()) {
        updates.composioUserId = composioUserIdInput.trim()
      }
      if (Object.keys(updates).length > 0) {
        await updateSettings.mutateAsync({
          apiKeys: updates,
        })
        setComposioApiKeyInput('')
        setComposioUserIdInput('')
        setShowComposioApiKey(false)
      }
    } catch (error) {
      console.error('Failed to save Composio settings:', error)
    } finally {
      setIsSavingComposio(false)
    }
  }

  const handleRemoveComposioApiKey = async () => {
    setIsSavingComposio(true)
    try {
      await updateSettings.mutateAsync({
        apiKeys: { composioApiKey: '' },
      })
    } catch (error) {
      console.error('Failed to remove Composio API key:', error)
    } finally {
      setIsSavingComposio(false)
    }
  }

  const handleRemoveComposioUserId = async () => {
    setIsSavingComposio(true)
    try {
      await updateSettings.mutateAsync({
        apiKeys: { composioUserId: '' },
      })
    } catch (error) {
      console.error('Failed to remove Composio user ID:', error)
    } finally {
      setIsSavingComposio(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium">Composio Integration</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Configure the Composio account provider for OAuth connections (Gmail, Slack, GitHub, etc.).
        </p>
      </div>

      {/* Composio API Key */}
      <div className="space-y-2">
        <Label htmlFor="composio-api-key">Composio API Key</Label>

        {/* Source indicator */}
        {composioApiKeyStatus?.isConfigured && (
          <div className="flex items-center gap-2">
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${
                composioApiKeyStatus.source === 'settings'
                  ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                  : 'bg-blue-500/10 text-blue-700 dark:text-blue-400'
              }`}
            >
              {composioApiKeyStatus.source === 'settings'
                ? 'Using saved setting'
                : 'Using environment variable'}
            </span>
          </div>
        )}

        {/* Input with show/hide toggle */}
        <div className="relative">
          <Input
            id="composio-api-key"
            type={showComposioApiKey ? 'text' : 'password'}
            value={composioApiKeyInput}
            onChange={(e) => setComposioApiKeyInput(e.target.value)}
            placeholder={composioApiKeyStatus?.isConfigured ? '••••••••••••••••' : 'Enter Composio API key'}
            className="pr-10"
            disabled={isLoading}
          />
          <button
            type="button"
            onClick={() => setShowComposioApiKey(!showComposioApiKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            disabled={isLoading}
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

        {/* Remove button */}
        {composioApiKeyStatus?.source === 'settings' && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleRemoveComposioApiKey}
            disabled={isSavingComposio}
          >
            {isSavingComposio ? 'Removing...' : 'Remove Saved Key'}
          </Button>
        )}
      </div>

      {/* Composio User ID */}
      <div className="space-y-2">
        <Label htmlFor="composio-user-id">Composio User ID</Label>

        {/* Current value indicator */}
        {hasComposioUserId && (
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
              Configured
            </span>
          </div>
        )}

        <Input
          id="composio-user-id"
          type="text"
          value={composioUserIdInput}
          onChange={(e) => setComposioUserIdInput(e.target.value)}
          placeholder={hasComposioUserId ? 'Enter new user ID to replace' : 'Enter your Composio user ID'}
          disabled={isLoading}
        />

        <p className="text-xs text-muted-foreground">
          Your unique identifier in Composio. Can be any string (e.g., your email).
        </p>

        {/* Remove button */}
        {hasComposioUserId && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleRemoveComposioUserId}
            disabled={isSavingComposio}
          >
            {isSavingComposio ? 'Removing...' : 'Remove User ID'}
          </Button>
        )}
      </div>

      {/* Save button for Composio settings */}
      {(composioApiKeyInput.trim() || composioUserIdInput.trim()) && (
        <Button size="sm" onClick={handleSaveComposioSettings} disabled={isSavingComposio}>
          {isSavingComposio ? 'Saving...' : 'Save Composio Settings'}
        </Button>
      )}
    </div>
  )
}
