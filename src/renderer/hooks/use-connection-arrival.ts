import { useEffect, useRef } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useInitiateConnection } from '@renderer/hooks/use-connected-accounts'
import { isElectron } from '@renderer/lib/env'
import { SUPPORTED_PROVIDERS } from '@shared/lib/account-providers/service-catalog'

/**
 * A provider's install hands the account back to /settings/connections in its
 * catalog `arrivalParam`. The connect route decides what that identity means: the
 * account the user already has opens, or the grant starts in this tab with the
 * identity pre-filled, and the callback page returns to the new account.
 */
export function useConnectionArrival() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const arrival = SUPPORTED_PROVIDERS.find((p) => p.arrivalParam && typeof search[p.arrivalParam] === 'string')
  const param = arrival?.arrivalParam
  const identity = param ? (search[param] as string) : undefined
  const { mutateAsync: initiateConnection } = useInitiateConnection()
  const started = useRef<string>()
  useEffect(() => {
    // A deeplink opens a browser tab, never the desktop app. The ref covers a
    // StrictMode replay of this effect, before the URL change below has rendered.
    if (!arrival || !param || !identity || isElectron()) return
    if (started.current === identity) return
    started.current = identity
    // The identity leaves the URL first, so a remount or refetch cannot start a second grant.
    void navigate({
      to: '/settings/$tab',
      params: { tab: 'connections' },
      search: (prev) => ({ ...prev, [param]: undefined }),
      replace: true,
    })
    // No click to open a popup from, so a grant takes over this tab. The toast
    // stays until the tab leaves; an error replaces it in place.
    const toastId = toast.loading(`Opening ${identity}…`)
    initiateConnection({ providerSlug: arrival.slug, identity, location: `${arrival.slug}_install` })
      .then((result) => {
        if ('redirectUrl' in result) return window.location.assign(result.redirectUrl)
        toast.dismiss(toastId)
        void navigate({
          to: '/settings/$tab',
          params: { tab: 'connections' },
          search: (prev) => ({ ...prev, detail: `account-${result.accountId}`, connectionView: undefined }),
          replace: true,
        })
      })
      .catch((error: Error) => toast.error(error.message, { id: toastId }))
  }, [arrival, param, identity, initiateConnection, navigate])
}
