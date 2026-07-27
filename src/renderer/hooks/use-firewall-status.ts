import { apiFetch } from '@renderer/lib/api'
import { canUseHostFeatures } from '@renderer/lib/host-features'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export interface FirewallStatusResponse {
  supported: boolean
  blocked: boolean
  blockRuleNames: string[]
  hyperVInboundBlock: boolean
}

export type FirewallFixResponse =
  | { ok: true; status: FirewallStatusResponse }
  | { ok: false; reason: 'uac-declined' | 'failed' | 'unsupported'; detail?: string }

export function useFirewallStatus() {
  return useQuery<FirewallStatusResponse>({
    queryKey: ['firewall-status'],
    queryFn: async () => {
      const res = await apiFetch('/api/firewall/status')
      if (!res.ok) throw new Error('Failed to fetch firewall status')
      return res.json()
    },
    // The problem this detects is Windows Firewall rules on the machine running
    // the app, blocking its own containers from reaching it. Against a cloud
    // workspace the question goes to the deployment and is about a firewall
    // nobody here can see or fix, so don't ask it at all.
    enabled: canUseHostFeatures(),
    // Detection is cached server-side; this just keeps a long-lived window
    // from going stale if the user fixes the firewall outside the app.
    refetchInterval: 5 * 60_000,
  })
}

export function useFixFirewall() {
  const queryClient = useQueryClient()
  return useMutation<FirewallFixResponse, Error>({
    mutationFn: async () => {
      // The route answers 502 with a JSON body when the fix fails — that body
      // (uac-declined vs failed) drives the banner copy, so parse it either way.
      const res = await apiFetch('/api/firewall/fix', { method: 'POST' })
      return res.json()
    },
    onSuccess: (result) => {
      if (result.ok) {
        queryClient.setQueryData(['firewall-status'], result.status)
      }
    },
  })
}
