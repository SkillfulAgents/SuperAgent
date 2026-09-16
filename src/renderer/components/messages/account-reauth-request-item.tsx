import { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { useOAuthReconnect } from '@renderer/hooks/use-oauth-reconnect'
import { useConnectedAccounts } from '@renderer/hooks/use-connected-accounts'
import { dismissReauthRequest } from '@renderer/lib/reauth-dismiss'
import { getProvider } from '@shared/lib/account-providers/service-catalog'
import { DeclineButton } from './decline-button'
import { RequestItemActions } from './request-item-actions'
import { RequestItemShell } from './request-item-shell'
import { ConnectedAccountRequestItem } from './connected-account-request-item'

interface AccountReauthRequestItemProps {
  proxyRequestId: string
  accountId: string
  toolkit: string
  accountStatus: 'expired' | 'revoked'
  sessionId?: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

export function AccountReauthRequestItem({
  proxyRequestId,
  accountId,
  toolkit,
  accountStatus,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: AccountReauthRequestItemProps) {
  const [replacing, setReplacing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dismissing, setDismissing] = useState(false)
  const { reconnect, pendingAccountId } = useOAuthReconnect()
  const { data: connectedAccounts } = useConnectedAccounts()
  const isReconnecting = pendingAccountId === accountId
  const providerName = getProvider(toolkit)?.displayName
    ?? `${toolkit.charAt(0).toUpperCase()}${toolkit.slice(1)}`
  const statusLabel = accountStatus === 'expired' ? 'expired' : 'been revoked'
  const ownsAccount = connectedAccounts?.accounts.some((account) => account.id === accountId)
  const canReconnect = !readOnly && ownsAccount === true
  // Members can supply their own replacement without modifying the owner's credentials.
  const canDismiss = !readOnly

  const handleReconnect = async () => {
    setError(null)
    const succeeded = await reconnect(accountId, toolkit)
    if (succeeded) {
      onComplete()
    } else {
      setError('Reconnection was not completed. Try again to continue the request.')
    }
  }

  const handleDismiss = async (reason?: string) => {
    setError(null)
    setDismissing(true)
    try {
      await dismissReauthRequest({ agentSlug, requestId: proxyRequestId, reason })
      onComplete()
    } catch (dismissError) {
      setError(dismissError instanceof Error ? dismissError.message : 'Failed to dismiss the request')
    } finally {
      setDismissing(false)
    }
  }

  if (replacing && !readOnly) {
    return (
      <ConnectedAccountRequestItem
        toolUseId={proxyRequestId}
        toolkit={toolkit}
        reason={`Replace ${providerName} connection`}
        sessionId={sessionId}
        agentSlug={agentSlug}
        replacement={{ requestId: proxyRequestId, onCancel: () => setReplacing(false) }}
        onComplete={onComplete}
      />
    )
  }

  return (
    <RequestItemShell
      title={`This request needs ${providerName} access that has ${statusLabel}.`}
      subtitle={ownsAccount === false
        ? 'Replace it with an account you own to continue, or dismiss this request.'
        : 'Reconnect to continue. The original request will resume automatically.'}
      icon={<ServiceIcon slug={toolkit} fallback="oauth" className="h-4 w-4" />}
      theme="orange"
      sessionId={sessionId}
      agentSlug={agentSlug}
      readOnly={canDismiss ? false : {}}
      waitingText="Waiting for reconnection"
      error={error}
      data-testid="account-reauth-request"
      data-status={accountStatus}
    >
      {canDismiss && (
        <RequestItemActions>
          <DeclineButton
            onDecline={(reason) => { void handleDismiss(reason) }}
            disabled={dismissing || isReconnecting}
            label="Dismiss"
            data-testid="account-reauth-dismiss-btn"
          />
          <Button
            type="button"
            size="xs"
            variant={canReconnect ? 'outline' : 'default'}
            onClick={() => setReplacing(true)}
            disabled={isReconnecting || dismissing}
            data-testid="account-reauth-replace-btn"
          >
            Replace connection
          </Button>
          {canReconnect && (
            <Button
              type="button"
              size="xs"
              onClick={handleReconnect}
              disabled={isReconnecting || dismissing}
              data-testid="account-reauth-reconnect-btn"
            >
              {isReconnecting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              {isReconnecting ? 'Reconnecting…' : 'Reconnect'}
            </Button>
          )}
        </RequestItemActions>
      )}
      <span className="sr-only">Proxy request {proxyRequestId}</span>
    </RequestItemShell>
  )
}
