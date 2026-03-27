import { useState, useEffect } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { ComposioApiKeyInput } from '@renderer/components/settings/composio-api-key-input'
import { Check } from 'lucide-react'
import { ConnectedAccountsSection } from '@renderer/components/connected-accounts-section'
import { useUser } from '@renderer/context/user-context'
import { PolicyDecisionToggle } from '@renderer/components/ui/policy-decision-toggle'

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

  const { data: userSettings } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()
  const currentPolicy = userSettings?.defaultApiPolicy ?? 'review'

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

      {isComposioConfigured && (
        <>
          <div className="rounded-md border p-3 space-y-2">
            <div>
              <Label className="text-sm font-medium">Default API Request Policy</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                When agents make API calls or use MCP tools, this policy determines what happens by default.
                You can override this per-account or per-tool later in Settings.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <PolicyDecisionToggle
                value={currentPolicy}
                onChange={(value) => {
                  if (value === 'default') return // Global default must be set
                  updateUserSettings.mutate({ defaultApiPolicy: value })
                }}
                size="md"
              />
              <span className="text-xs text-muted-foreground">
                {currentPolicy === 'allow' && 'Agents can make API calls without asking.'}
                {currentPolicy === 'review' && 'You\'ll be prompted to approve each new type of request.'}
                {currentPolicy === 'block' && 'All API calls are blocked until you add explicit allow rules.'}
              </span>
            </div>
          </div>
          <div className="pt-2 border-t">
            <ConnectedAccountsSection />
          </div>
        </>
      )}
    </div>
  )
}
