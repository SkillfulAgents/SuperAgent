import { ConnectedAccountsSection } from '@renderer/components/connected-accounts-section'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { Label } from '@renderer/components/ui/label'
import { PolicyDecisionToggle } from '@renderer/components/ui/policy-decision-toggle'

export function AccountsTab() {
  const { data: settings } = useUserSettings()
  const updateSettings = useUpdateUserSettings()

  const currentPolicy = settings?.defaultApiPolicy ?? 'review'

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">Connected Accounts</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Manage your OAuth connections to external services.
        </p>
      </div>

      {/* Global default API policy */}
      <div className="flex items-center justify-between rounded-md border p-3">
        <div>
          <Label className="text-sm font-medium">Default API Request Policy</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Controls what happens when agents make API calls without a specific scope policy.
          </p>
        </div>
        <PolicyDecisionToggle
          value={currentPolicy}
          onChange={(value) => {
            if (value === 'default') return // Global default must be set
            updateSettings.mutate({ defaultApiPolicy: value })
          }}
          size="md"
        />
      </div>

      <ConnectedAccountsSection />
    </div>
  )
}
