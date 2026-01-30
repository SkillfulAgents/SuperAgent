import { useState, useEffect } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
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
import { useSettings, useUpdateSettings, useFactoryReset } from '@renderer/hooks/use-settings'
import { AlertTriangle, Eye, EyeOff, RotateCcw } from 'lucide-react'

export function GeneralTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()

  // API key state
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [isSavingApiKey, setIsSavingApiKey] = useState(false)

  // Menu bar toggle state - use local state for optimistic UI
  const [menuBarEnabled, setMenuBarEnabled] = useState<boolean | null>(null)

  // Reset optimistic state when settings update
  useEffect(() => {
    if (settings) {
      setMenuBarEnabled(null)
    }
  }, [settings])

  const handleSaveApiKey = async () => {
    if (!apiKeyInput.trim()) return
    setIsSavingApiKey(true)
    try {
      await updateSettings.mutateAsync({
        apiKeys: { anthropicApiKey: apiKeyInput.trim() },
      })
      setApiKeyInput('')
      setShowApiKey(false)
    } catch (error) {
      console.error('Failed to save API key:', error)
    } finally {
      setIsSavingApiKey(false)
    }
  }

  const handleRemoveApiKey = async () => {
    setIsSavingApiKey(true)
    try {
      await updateSettings.mutateAsync({
        apiKeys: { anthropicApiKey: '' },
      })
    } catch (error) {
      console.error('Failed to remove API key:', error)
    } finally {
      setIsSavingApiKey(false)
    }
  }

  const factoryReset = useFactoryReset()
  const [isResetting, setIsResetting] = useState(false)

  const handleFactoryReset = async () => {
    setIsResetting(true)
    try {
      await factoryReset.mutateAsync()
      window.location.reload()
    } catch (error) {
      console.error('Factory reset failed:', error)
      setIsResetting(false)
    }
  }

  const apiKeyStatus = settings?.apiKeyStatus?.anthropic

  return (
    <div className="space-y-6">
      {/* Menu Bar Icon Toggle - Only show in Electron */}
      {window.electronAPI && (
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="show-menu-bar-icon">Show in Menu Bar</Label>
            <p className="text-xs text-muted-foreground">
              Display agent status icon in the macOS menu bar
            </p>
          </div>
          <Switch
            id="show-menu-bar-icon"
            checked={menuBarEnabled ?? settings?.app?.showMenuBarIcon !== false}
            onCheckedChange={(checked: boolean) => {
              // Optimistic update - immediately reflect in UI
              setMenuBarEnabled(checked)
              // Toggle tray visibility (instant)
              window.electronAPI?.setTrayVisible(checked)
              // Save setting in background
              updateSettings.mutate({ app: { showMenuBarIcon: checked } })
            }}
            disabled={isLoading}
          />
        </div>
      )}

      {/* Data Location - Read Only */}
      <div className="space-y-2">
        <Label htmlFor="data-location">Data Location</Label>
        <Input
          id="data-location"
          value={isLoading ? 'Loading...' : settings?.dataDir ?? ''}
          readOnly
          className="bg-muted"
        />
        <p className="text-xs text-muted-foreground">
          Configure via <code className="bg-muted px-1 rounded">SUPERAGENT_DATA_DIR</code> environment variable.
        </p>
      </div>

      {/* API Keys Section */}
      <div className="pt-4 border-t space-y-4">
        <h3 className="text-sm font-medium">API Keys</h3>

        <div className="space-y-2">
          <Label htmlFor="anthropic-api-key">Anthropic API Key</Label>

          {/* Source indicator */}
          {apiKeyStatus?.isConfigured && (
            <div className="flex items-center gap-2">
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  apiKeyStatus.source === 'settings'
                    ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                    : 'bg-blue-500/10 text-blue-700 dark:text-blue-400'
                }`}
              >
                {apiKeyStatus.source === 'settings'
                  ? 'Using saved setting'
                  : 'Using environment variable'}
              </span>
            </div>
          )}

          {!apiKeyStatus?.isConfigured && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                No API key configured. Set <code className="bg-muted px-1 rounded">ANTHROPIC_API_KEY</code> environment variable or enter below.
              </AlertDescription>
            </Alert>
          )}

          {/* Input with show/hide toggle */}
          <div className="relative">
            <Input
              id="anthropic-api-key"
              type={showApiKey ? 'text' : 'password'}
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder={apiKeyStatus?.isConfigured ? '••••••••••••••••' : 'sk-ant-...'}
              className="pr-10"
              disabled={isLoading}
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              disabled={isLoading}
            >
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          <p className="text-xs text-muted-foreground">
            {apiKeyStatus?.source === 'settings'
              ? 'Your API key is saved locally. Enter a new key to replace it.'
              : apiKeyStatus?.source === 'env'
                ? 'Save a key here to override the environment variable.'
                : 'Your API key will be saved locally in ~/.superagent/settings.json'}
          </p>

          {/* Save/Remove buttons */}
          <div className="flex gap-2">
            {apiKeyInput.trim() && (
              <Button size="sm" onClick={handleSaveApiKey} disabled={isSavingApiKey}>
                {isSavingApiKey ? 'Saving...' : 'Save API Key'}
              </Button>
            )}
            {apiKeyStatus?.source === 'settings' && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleRemoveApiKey}
                disabled={isSavingApiKey}
              >
                {isSavingApiKey ? 'Removing...' : 'Remove Saved Key'}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="pt-4 border-t space-y-4">
        <h3 className="text-sm font-medium text-destructive">Danger Zone</h3>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label>Factory Reset</Label>
            <p className="text-xs text-muted-foreground">
              Delete all agents, sessions, files, and settings
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm">
                <RotateCcw className="h-4 w-4 mr-2" />
                Factory Reset
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Factory Reset</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete all agents, sessions, files, scheduled tasks,
                  connected accounts, and settings. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isResetting}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleFactoryReset}
                  disabled={isResetting}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {isResetting ? 'Resetting...' : 'Reset Everything'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  )
}
