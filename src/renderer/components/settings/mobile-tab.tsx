import { useCallback, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'react-qr-code'
import { Loader2, QrCode, RefreshCw, Smartphone, Trash2 } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { cn } from '@shared/lib/utils'
import { Label } from '@renderer/components/ui/label'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'

interface PairingToken {
  token: string
  expiresAt: string
  deploymentUrl: string
}

interface MobileDevice {
  id: string
  deviceName: string | null
  createdAt: string
  updatedAt: string
  expiresAt: string
  isCurrent: boolean
}

/** Mint interval headroom: re-mint while the QR is visible ~60s before expiry. */
const REMINT_BEFORE_EXPIRY_MS = 60 * 1000

function buildDeepLink(pairing: PairingToken): string {
  return `gamut://connect?v=1&url=${encodeURIComponent(pairing.deploymentUrl)}&token=${pairing.token}`
}

async function mintPairingToken(): Promise<PairingToken> {
  const res = await apiFetch('/api/auth/mobile/pairing-token', { method: 'POST' })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || 'Failed to create pairing code')
  }
  return res.json()
}

// --- QR pairing card ---

function PairingQrCard() {
  const [pairing, setPairing] = useState<PairingToken | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [minting, setMinting] = useState(false)

  const mint = useCallback(async () => {
    setMinting(true)
    setError(null)
    try {
      setPairing(await mintPairingToken())
    } catch (err) {
      setPairing(null)
      setError(err instanceof Error ? err.message : 'Failed to create pairing code')
    } finally {
      setMinting(false)
    }
  }, [])

  // Countdown + auto-re-mint while a code is on screen. Tokens are minted on
  // demand only — never on tab open.
  useEffect(() => {
    if (!pairing) return
    const tick = () => {
      const remainingMs = new Date(pairing.expiresAt).getTime() - Date.now()
      setSecondsLeft(Math.max(0, Math.ceil(remainingMs / 1000)))
      if (remainingMs <= REMINT_BEFORE_EXPIRY_MS) {
        void mint()
      }
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [pairing, mint])

  const deepLink = pairing ? buildDeepLink(pairing) : null

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Scan the QR code with the Gamut mobile app to connect it to this workspace. Codes are
        single-use and expire after a few minutes.
      </p>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!pairing ? (
        <Button onClick={() => void mint()} disabled={minting} data-testid="mobile-pairing-mint">
          {minting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <QrCode className="h-4 w-4 mr-2" />
          )}
          Show pairing code
        </Button>
      ) : (
        <div className="space-y-3">
          <div className="inline-flex flex-col items-center gap-2 rounded-lg border p-4 bg-white">
            {deepLink && <QRCode value={deepLink} size={192} />}
          </div>
          <p className="text-xs text-muted-foreground">
            Code refreshes automatically — expires in {secondsLeft}s
          </p>
          {/* The raw deep link, for copying into the app manually (and E2E). */}
          <p
            className="text-xs font-mono break-all text-muted-foreground select-all"
            data-testid="mobile-pairing-deeplink"
          >
            {deepLink}
          </p>
        </div>
      )}
    </div>
  )
}

// --- Open-the-app button (same-device pairing) ---

function ConnectAppButton() {
  const [minting, setMinting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Mint on click, then navigate to the freshly-minted deep link. The href is
  // decorative until then — a stale link would carry an expired token.
  const handleClick = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    if (minting) return
    setMinting(true)
    setError(null)
    try {
      const pairing = await mintPairingToken()
      window.location.href = buildDeepLink(pairing)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect')
    } finally {
      setMinting(false)
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        On this device already? Open the app directly.
      </p>
      {/* A real anchor (deep links belong on links), styled as an outline
          button. Not `Button asChild`: this repo's Button always renders a
          conditional loading child, which breaks Radix Slot's single-child
          requirement. */}
      <a
        href="gamut://connect"
        onClick={handleClick}
        data-testid="mobile-connect-app-button"
        className={cn(buttonVariants({ variant: 'outline' }), minting && 'pointer-events-none opacity-50')}
      >
        {minting ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Smartphone className="h-4 w-4 mr-2" />
        )}
        Connect app on this device
      </a>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

// --- Paired devices list ---

function formatDate(iso: string): string {
  const date = new Date(iso)
  return isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

function PairedDevicesList() {
  const queryClient = useQueryClient()
  const [revokeError, setRevokeError] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['mobile-devices'],
    queryFn: async (): Promise<{ devices: MobileDevice[] }> => {
      const res = await apiFetch('/api/auth/mobile/devices')
      if (!res.ok) throw new Error('Failed to load paired devices')
      return res.json()
    },
  })

  const revokeMutation = useMutation({
    mutationFn: async (deviceId: string) => {
      const res = await apiFetch(`/api/auth/mobile/devices/${deviceId}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error || 'Failed to revoke device')
      }
    },
    onSuccess: () => {
      setRevokeError(null)
      queryClient.invalidateQueries({ queryKey: ['mobile-devices'] })
    },
    onError: (err) => {
      setRevokeError(err instanceof Error ? err.message : 'Failed to revoke device')
    },
  })

  const devices = data?.devices ?? []

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading devices…
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Failed to load paired devices</AlertDescription>
      </Alert>
    )
  }

  if (devices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="mobile-devices-empty">
        No paired devices yet.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      {revokeError && (
        <Alert variant="destructive">
          <AlertDescription>{revokeError}</AlertDescription>
        </Alert>
      )}
      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Device</th>
              <th className="px-3 py-2 font-medium">Paired</th>
              <th className="px-3 py-2 font-medium">Last renewed</th>
              <th className="px-3 py-2 font-medium">Expires</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody data-testid="mobile-devices-list">
            {devices.map((device) => (
              <tr key={device.id} className="border-b last:border-b-0" data-testid={`mobile-device-row-${device.id}`}>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4 text-muted-foreground" />
                    {device.deviceName || 'Mobile device'}
                    {device.isCurrent && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        current
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{formatDate(device.createdAt)}</td>
                <td className="px-3 py-2 text-muted-foreground">{formatDate(device.updatedAt)}</td>
                <td className="px-3 py-2 text-muted-foreground">{formatDate(device.expiresAt)}</td>
                <td className="px-3 py-2 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => revokeMutation.mutate(device.id)}
                    disabled={revokeMutation.isPending}
                    data-testid={`mobile-device-revoke-${device.id}`}
                    aria-label="Revoke device"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// --- Main tab ---

export function MobileTab() {
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <Label className="text-base">Pair the mobile app</Label>
        <PairingQrCard />
        <ConnectAppButton />
      </div>

      <div className="pt-4 border-t space-y-4">
        <div className="flex items-center justify-between">
          <Label className="text-base">Paired devices</Label>
          <RefreshDevicesButton />
        </div>
        <PairedDevicesList />
      </div>
    </div>
  )
}

function RefreshDevicesButton() {
  const queryClient = useQueryClient()
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => queryClient.invalidateQueries({ queryKey: ['mobile-devices'] })}
      aria-label="Refresh devices"
    >
      <RefreshCw className="h-4 w-4" />
    </Button>
  )
}
