import { ConnectedAccountsSection } from '@renderer/components/connected-accounts-section'

export function AccountsTab() {
  return (
    <div className="space-y-4">
      <section className="space-y-4">
        <h3 className="text-sm font-medium">Connected Accounts</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Manage your OAuth connections to external services.
        </p>
        <ConnectedAccountsSection />
      </section>
    </div>
  )
}
