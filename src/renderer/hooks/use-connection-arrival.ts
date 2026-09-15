import { useEffect, useRef } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useConnectedAccounts, useInitiateConnection } from '@renderer/hooks/use-connected-accounts'
import { isElectron } from '@renderer/lib/env'
import { SUPPORTED_PROVIDERS } from '@shared/lib/account-providers/service-catalog'

/**
 * A provider's install hands the account back to /settings/connections in its
 * catalog `arrivalParam`. An account that is already connected opens; any other
 * is connected here, in this tab, with the identity pre-filled, and the callback
 * page returns to the new account.
 */
export function useConnectionArrival() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const arrival = SUPPORTED_PROVIDERS.find((p) => p.arrivalParam && typeof search[p.arrivalParam] === 'string')
  const param = arrival?.arrivalParam
  const identity = param ? (search[param] as string) : undefined
  const { data: accountsData } = useConnectedAccounts()
  const { mutateAsync: initiateConnection } = useInitiateConnection()
  const started = useRef<string>()
  useEffect(() => {
    // Wait for the account list so a connected account is never granted again.
    // A deeplink opens a browser tab, never the desktop app. The ref covers a
    // StrictMode replay of this effect, before the URL change below has rendered.
    if (!arrival || !param || !identity || !accountsData || isElectron()) return
    if (started.current === identity) return
    started.current = identity
    const connected = accountsData.accounts.find(
      (a) => a.toolkitSlug === arrival.slug && a.displayName === identity && a.status === 'active',
    )
    // The identity leaves the URL first, so a remount or refetch cannot start a second grant.
    void navigate({
      to: '/settings/$tab',
      params: { tab: 'connections' },
      search: (prev) => ({
        ...prev,
        [param]: undefined,
        ...(connected ? { detail: `account-${connected.id}`, connectionView: undefined } : {}),
      }),
      replace: true,
    })
    if (connected) return
    // No click to open a popup from, so the grant takes over this tab. The toast
    // stays until the tab leaves; an error replaces it in place.
    const toastId = toast.loading(`Connecting ${identity}…`)
    initiateConnection({ providerSlug: arrival.slug, identity, location: `${arrival.slug}_install` })
      .then(({ redirectUrl }) => window.location.assign(redirectUrl))
      .catch((error: Error) => toast.error(error.message, { id: toastId }))
  }, [arrival, param, identity, accountsData, initiateConnection, navigate])
}
