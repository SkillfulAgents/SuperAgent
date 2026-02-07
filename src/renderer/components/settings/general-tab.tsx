import { useState, useEffect } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
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
import { RotateCcw, Wand2 } from 'lucide-react'
import { AnthropicApiKeyInput } from './anthropic-api-key-input'
import { UpdateSection } from './update-section'

const MODEL_OPTIONS = [
  { value: 'claude-haiku-4-5', label: 'Claude 4.5 Haiku' },
  { value: 'claude-sonnet-4-5', label: 'Claude 4.5 Sonnet' },
  { value: 'claude-opus-4-5', label: 'Claude 4.5 Opus' },
]

interface GeneralTabProps {
  onOpenWizard: () => void
}

export function GeneralTab({ onOpenWizard }: GeneralTabProps) {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()

  // Menu bar toggle state - use local state for optimistic UI
  const [menuBarEnabled, setMenuBarEnabled] = useState<boolean | null>(null)

  // Reset optimistic state when settings update
  useEffect(() => {
    if (settings) {
      setMenuBarEnabled(null)
    }
  }, [settings])

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
        <AnthropicApiKeyInput disabled={isLoading} />
      </div>

      {/* Models Section */}
      <div className="pt-4 border-t space-y-4">
        <h3 className="text-sm font-medium">Models</h3>
        <div className="space-y-2">
          <Label htmlFor="agent-model">Agent Model</Label>
          <Select
            value={settings?.models?.agentModel ?? 'claude-opus-4-5'}
            onValueChange={(value) => {
              updateSettings.mutate({ models: { agentModel: value } })
            }}
            disabled={isLoading}
          >
            <SelectTrigger id="agent-model">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {MODEL_OPTIONS.map((model) => (
                <SelectItem key={model.value} value={model.value}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Model used for agent sessions
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="summarizer-model">Summarizer Model</Label>
          <Select
            value={settings?.models?.summarizerModel ?? 'claude-haiku-4-5'}
            onValueChange={(value) => {
              updateSettings.mutate({ models: { summarizerModel: value } })
            }}
            disabled={isLoading}
          >
            <SelectTrigger id="summarizer-model">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {MODEL_OPTIONS.map((model) => (
                <SelectItem key={model.value} value={model.value}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Model used for session name generation and API key validation
          </p>
        </div>
      </div>

      {/* Software Updates - Only in Electron */}
      {window.electronAPI && (
        <div className="pt-4 border-t space-y-4">
          <UpdateSection />
        </div>
      )}

      {/* Setup Wizard */}
      <div className="pt-4 border-t space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label>Setup Wizard</Label>
            <p className="text-xs text-muted-foreground">
              Re-run the getting started wizard to reconfigure your setup
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onOpenWizard} data-testid="rerun-wizard-button">
            <Wand2 className="h-4 w-4 mr-2" />
            Re-run Wizard
          </Button>
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
