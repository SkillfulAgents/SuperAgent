import { useMemo, useState, type ReactNode } from 'react'
import { ArrowUpRight, BadgeX, Loader2 } from 'lucide-react'

import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { RequestError } from '@renderer/components/messages/request-error'
import { usePlatformConnect, useSavePlatformAccessKey } from '@renderer/hooks/use-platform-auth'

interface PlatformTabProps {
  readOnly?: boolean
}

interface SettingRowProps {
  name: string
  subtitle?: ReactNode
  right: ReactNode
}

function SettingRow({ name, subtitle, right }: SettingRowProps) {
  return (
    <div className="py-3 px-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium truncate">{name}</div>
          {subtitle && (
            <div className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">{right}</div>
      </div>
    </div>
  )
}

const CARD_CLASS = 'rounded-xl border bg-background divide-y divide-border/50 overflow-hidden'

function HoverArrow() {
  return (
    <span className="inline-flex overflow-hidden w-0 ml-0 opacity-0 transition-all duration-150 group-hover:w-4 group-hover:ml-2 group-hover:opacity-100 group-focus-visible:w-4 group-focus-visible:ml-2 group-focus-visible:opacity-100">
      <ArrowUpRight className="h-4 w-4 shrink-0" />
    </span>
  )
}

function AccessKeyInput({ onClose }: { onClose: () => void }) {
  const [key, setKey] = useState('')
  const saveKey = useSavePlatformAccessKey()

  return (
    <>
      <div className="flex items-center gap-2">
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Paste account key"
          className="font-mono text-xs h-8 flex-1"
          autoFocus
        />
        <Button
          size="sm"
          className="h-8"
          disabled={!key.trim() || saveKey.isPending}
          onClick={() => {
            saveKey.mutate(key.trim(), { onSuccess: onClose })
          }}
        >
          {saveKey.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Submit'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8"
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>
      <RequestError message={saveKey.isError ? saveKey.error.message : null} />
    </>
  )
}

interface NotConnectedEmptyStateProps {
  readOnly: boolean
  isLaunching: boolean
  onConnect: () => void
}

function NotConnectedEmptyState({ readOnly, isLaunching, onConnect }: NotConnectedEmptyStateProps) {
  const [showKeyInput, setShowKeyInput] = useState(false)

  return (
    <div className="rounded-xl border border-dashed bg-background px-6 py-10">
      <div className="flex flex-col items-center text-center gap-3">
        <div className="rounded-full bg-muted p-3">
          <BadgeX className="h-5 w-5 text-muted-foreground" />
        </div>
        <h3 className="text-sm font-normal">No Superagent account connected to this workspace</h3>
        {!readOnly && (
          <div className="w-full max-w-sm mt-3 space-y-2">
            {showKeyInput ? (
              <AccessKeyInput onClose={() => setShowKeyInput(false)} />
            ) : (
              <div className="flex items-center justify-center gap-2">
                <Button size="sm" onClick={onConnect} disabled={isLaunching} className="group gap-0">
                  {isLaunching ? 'Opening browser…' : 'Connect Account'}
                  {isLaunching ? (
                    <Loader2 className="ml-2 h-4 w-4 animate-spin" />
                  ) : (
                    <HoverArrow />
                  )}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowKeyInput(true)}>
                  Add access key
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface ReconnectRowProps {
  readOnly: boolean
  isLaunching: boolean
  connectLabel: string
  onReconnect: () => void
}

function ReconnectRow({ readOnly, isLaunching, connectLabel, onReconnect }: ReconnectRowProps) {
  const [showInput, setShowInput] = useState(false)

  if (showInput) {
    return (
      <div className="py-3 px-4 space-y-2">
        <AccessKeyInput onClose={() => setShowInput(false)} />
      </div>
    )
  }

  return (
    <div className="py-3 px-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium truncate">Issues? Try reconnecting</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Sign in to your account on the web or add an access key.
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="outline"
            onClick={onReconnect}
            disabled={readOnly || isLaunching}
            className="group gap-0"
          >
            {connectLabel}
            {isLaunching ? (
              <Loader2 className="ml-2 h-4 w-4 animate-spin" />
            ) : (
              <HoverArrow />
            )}
          </Button>
          {!readOnly && (
            <Button size="sm" variant="outline" onClick={() => setShowInput(true)}>
              Add key
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

export function PlatformTab({ readOnly = false }: PlatformTabProps) {
  const {
    handleConnect,
    isLaunching,
    error,
    message,
    isConnected,
    platformAuth: data,
    isLoadingPlatformAuth: isLoading,
  } = usePlatformConnect({
    successMessage: 'Connected. Please restart your running agents for the new token to take effect.',
  })

  const connectLabel = useMemo(() => {
    if (isLaunching) return 'Opening browser…'
    return isConnected ? 'Reconnect' : 'Connect'
  }, [isConnected, isLaunching])

  async function handleOpenPlatform() {
    if (!data?.platformBaseUrl) return
    if (window.electronAPI?.openExternal) {
      await window.electronAPI.openExternal(data.platformBaseUrl)
      return
    }
    window.open(data.platformBaseUrl, '_blank', 'noopener,noreferrer')
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading platform status…</span>
      </div>
    )
  }

  const valueClass = 'text-xs text-muted-foreground truncate max-w-[260px]'

  return (
    <div className="space-y-6">
      {isConnected && (
        <div className={CARD_CLASS}>
          <SettingRow
            name="Email"
            right={<span className={valueClass}>{data?.email ?? '—'}</span>}
          />
          <SettingRow
            name="Organization"
            right={<span className={valueClass}>{data?.orgName ?? '—'}</span>}
          />
          <SettingRow
            name="Role"
            right={<span className={`${valueClass} capitalize`}>{data?.role ?? '—'}</span>}
          />
          <SettingRow
            name="Last updated"
            right={<span className={valueClass}>{formatTimestamp(data?.updatedAt ?? null)}</span>}
          />
          <SettingRow
            name="Manage your account and organization on the web"
            right={
              <Button
                size="sm"
                className="group gap-0"
                onClick={() => {
                  void handleOpenPlatform()
                }}
                disabled={!data?.platformBaseUrl}
              >
                Go to Account
                <HoverArrow />
              </Button>
            }
          />
        </div>
      )}

      {isConnected ? (
        <div className={CARD_CLASS}>
          <ReconnectRow
            readOnly={readOnly}
            isLaunching={isLaunching}
            connectLabel={connectLabel}
            onReconnect={handleConnect}
          />
        </div>
      ) : (
        <NotConnectedEmptyState
          readOnly={readOnly}
          isLaunching={isLaunching}
          onConnect={handleConnect}
        />
      )}

      {readOnly && (
        <Alert>
          <AlertDescription>
            Platform access is managed by this deployment. Connection changes must be made by updating the deployment environment bundle.
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" className="py-2 text-xs">
          <AlertDescription className="text-xs">
            {error}
            {error.includes('membership') ? ' Create or join an organization in Platform, then try again.' : ''}
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
