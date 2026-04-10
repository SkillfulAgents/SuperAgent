import { useState, useEffect } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { ComposioApiKeyInput } from '@renderer/components/settings/composio-api-key-input'
import { CircleCheckBig, ChevronRight } from 'lucide-react'
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
  const [showInstructions, setShowInstructions] = useState(false)

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

      <div className={`rounded-lg border p-3 transition-colors ${isComposioConfigured ? 'border-green-500 bg-green-50' : 'border-primary'}`}>
        <div className="flex items-center gap-2">
          {isComposioConfigured && <CircleCheckBig className="h-4 w-4 text-green-600" />}
          <span className={`font-medium text-sm ${isComposioConfigured ? 'text-green-700 dark:text-green-400' : ''}`}>
            {isComposioConfigured ? 'Composio connected' : 'Connect to Composio'}
          </span>
        </div>
        {isComposioConfigured && (
          <p className="text-xs text-green-700/80 dark:text-green-400/80 mt-2">
            You&apos;ll be able to connect your apps when you build your agents.<br />You can manage app connections in settings.
          </p>
        )}

        <div className={`grid transition-all duration-300 ease-in-out ${!isComposioConfigured ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="overflow-hidden">
            <div className="space-y-3 pt-3">
              <div className="space-y-1">
                <Label htmlFor="wizard-composio-userid">Composio User ID</Label>
                <Input
                  id="wizard-composio-userid"
                  type="text"
                  value={isAuthMode ? (user?.id ?? '') : composioUserIdInput}
                  onChange={(e) => setComposioUserIdInput(e.target.value)}
                  placeholder="Enter your Composio user ID (e.g., your email)"
                  disabled={isAuthMode}
                />
              </div>

              <ComposioApiKeyInput
                showRemoveButton={false}
                showSourceIndicator={false}
                showHelpText={false}
                validateButtonLabel="Connect"
              />

              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setShowInstructions(!showInstructions)}
                  className="text-sm text-primary hover:underline flex items-center gap-1"
                >
                  <ChevronRight className={`h-3 w-3 transition-transform ${showInstructions ? 'rotate-90' : ''}`} />
                  How to get your API key
                </button>

                {showInstructions && (
                  <div className="mt-2 p-2.5 rounded-md border bg-muted/30">
                    <ol className="list-decimal list-inside space-y-1 text-xs text-muted-foreground">
                      <li>Go to the{' '}
                        <a
                          href="https://app.composio.dev/settings"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline underline-offset-4"
                        >
                          Composio Dashboard
                        </a>
                      </li>
                      <li>Navigate to Settings and copy your API key</li>
                      <li>Paste it in the field above</li>
                    </ol>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}
