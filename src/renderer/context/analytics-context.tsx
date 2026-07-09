import { createContext, useContext, useEffect, useMemo, useRef, useCallback, type ReactNode } from 'react'
import type { AnalyticsInstance } from 'analytics'
import { useSettings } from '@renderer/hooks/use-settings'
import { useUser } from '@renderer/context/user-context'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { createAnalyticsInstance, getAnalyticsMetadata, hasActivePlugins } from '@renderer/lib/analytics'
import { claimFirstAgentCreated } from '@renderer/lib/first-agent-created'

interface AnalyticsContextValue {
  track: (event: string, properties?: Record<string, unknown>) => void
  /** Tracks agent_created, plus a once-per-user first_agent_created (ad-conversion dedup). */
  trackAgentCreated: (properties?: Record<string, unknown>) => void
  identify: () => void
}

const AnalyticsContext = createContext<AnalyticsContextValue | null>(null)

// Singleton reference so the analytics instance persists across re-renders
// but can be replaced when settings change
let currentInstance: AnalyticsInstance | null = null
let currentConfigKey = ''

function getConfigKey(shareAnalytics: boolean, targets?: { type: string; config: Record<string, string>; enabled: boolean }[]): string {
  return JSON.stringify({ shareAnalytics, targets: targets?.filter(t => t.enabled) ?? [] })
}

export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const { data: settings } = useSettings()
  const { user, isAuthMode } = useUser()
  const { data: platformStatus } = usePlatformAuthStatus()
  // Tracks the last value we called identify() with, so a mid-session identity
  // change (e.g. the platform connecting) re-identifies rather than sticking.
  const identifiedAsRef = useRef<string | null>(null)

  const tenantId = settings?.tenantId
  const shareAnalytics = settings?.shareAnalytics ?? false
  const analyticsTargets = settings?.analyticsTargets
  // Global platform user identity (Supabase auth UUID), present once connected.
  const platformUserId = platformStatus?.connected ? platformStatus.userId : null

  // Rebuild analytics instance when config changes
  const instance = useMemo(() => {
    const configKey = getConfigKey(shareAnalytics, analyticsTargets)
    if (configKey === currentConfigKey && currentInstance) {
      return currentInstance
    }

    if (!hasActivePlugins(shareAnalytics, analyticsTargets)) {
      currentInstance = null
      currentConfigKey = configKey
      return null
    }

    currentInstance = createAnalyticsInstance(shareAnalytics, analyticsTargets)
    currentConfigKey = configKey
    identifiedAsRef.current = null
    return currentInstance
  }, [shareAnalytics, analyticsTargets])

  // Build userId. The platform's global user id (one per human, stable across
  // installs/devices) takes precedence when connected; otherwise fall back to
  // the auth-mode composite, then the per-install tenantId.
  const userId = useMemo(() => {
    if (!tenantId) return null
    if (platformUserId) return platformUserId
    if (isAuthMode && user?.id) return `${tenantId}:${user.id}`
    return tenantId
  }, [tenantId, platformUserId, isAuthMode, user?.id])

  // Identify on instance creation or whenever the resolved identity changes.
  useEffect(() => {
    if (!instance || !userId || identifiedAsRef.current === userId) return
    const metadata = getAnalyticsMetadata()
    instance.identify(userId, {
      ...metadata,
      tenantId: tenantId!,
    })
    instance.track('identify', {
      ...metadata,
      source: 'client',
      tenantId: tenantId!,
    })
    identifiedAsRef.current = userId
  }, [instance, userId, tenantId])

  const track = useCallback((event: string, properties?: Record<string, unknown>) => {
    if (!instance) return
    const metadata = getAnalyticsMetadata()
    instance.track(event, {
      ...metadata,
      source: 'client',
      tenantId: tenantId ?? 'unknown',
      ...properties,
    })
  }, [instance, tenantId])

  // Best-effort once-per-user conversion signal: the Amplitude → Meta sync
  // subscribes to first_agent_created only, so Meta counts one conversion per user.
  const trackAgentCreated = useCallback((properties?: Record<string, unknown>) => {
    track('agent_created', properties)
    if (userId && claimFirstAgentCreated(userId)) {
      track('first_agent_created', properties)
    }
  }, [track, userId])

  const identify = useCallback(() => {
    if (!instance || !userId) return
    const metadata = getAnalyticsMetadata()
    instance.identify(userId, {
      ...metadata,
      tenantId: tenantId!,
    })
  }, [instance, userId, tenantId])

  const value = useMemo<AnalyticsContextValue>(
    () => ({ track, trackAgentCreated, identify }),
    [track, trackAgentCreated, identify],
  )

  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>
}

export function useAnalyticsTracking() {
  const context = useContext(AnalyticsContext)
  if (!context) {
    throw new Error('useAnalyticsTracking must be used within an AnalyticsProvider')
  }
  return context
}
