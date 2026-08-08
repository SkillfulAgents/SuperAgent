import { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { useOAuthReconnect } from '@renderer/hooks/use-oauth-reconnect'
import { getProvider } from '@shared/lib/account-providers/service-catalog'
import { RequestItemActions } from './request-item-actions'
import { RequestItemShell } from './request-item-shell'

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
  const [error, setError] = useState<string | null>(null)
  const { reconnect, pendingAccountId } = useOAuthReconnect()
  const isReconnecting = pendingAccountId === accountId
  const providerName = getProvider(toolkit)?.displayName
    ?? `${toolkit.charAt(0).toUpperCase()}${toolkit.slice(1)}`
  const statusLabel = accountStatus === 'expired' ? 'expired' : 'been revoked'

  const handleReconnect = async () => {
    setError(null)
    const succeeded = await reconnect(accountId, toolkit)
    if (succeeded) {
      onComplete()
    } else {
      setError('Reconnection was not completed. Try again to continue the request.')
    }
  }

  return (
    <RequestItemShell
      title={`This request needs ${providerName} access that has ${statusLabel}.`}
      subtitle="Reconnect to continue. The original request will resume automatically."
      icon={<ServiceIcon slug={toolkit} fallback="oauth" className="h-4 w-4" />}
      theme="orange"
      sessionId={sessionId}
      agentSlug={agentSlug}
      readOnly={readOnly ? {} : false}
      waitingText="Waiting for reconnection"
      error={error}
      data-testid="account-reauth-request"
      data-status={accountStatus}
    >
      <RequestItemActions>
        <Button
          type="button"
          size="xs"
          onClick={handleReconnect}
          disabled={isReconnecting}
          data-testid="account-reauth-reconnect-btn"
        >
          {isReconnecting ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          )}
          {isReconnecting ? 'Reconnecting…' : 'Reconnect'}
        </Button>
      </RequestItemActions>
      <span className="sr-only">Proxy request {proxyRequestId}</span>
    </RequestItemShell>
  )
}
