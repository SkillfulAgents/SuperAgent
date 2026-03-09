import { createContext, useContext, useEffect, useMemo, useRef, useCallback, type ReactNode } from 'react'
import type { AnalyticsInstance } from 'analytics'
import { useSettings } from '@renderer/hooks/use-settings'
import { useUser } from '@renderer/context/user-context'
import { createAnalyticsInstance, getAnalyticsMetadata, hasActivePlugins } from '@renderer/lib/analytics'

interface AnalyticsContextValue {
  track: (event: string, properties?: Record<string, unknown>) => void
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
  const identifiedRef = useRef(false)

  const tenantId = settings?.tenantId
  const shareAnalytics = settings?.shareAnalytics ?? false
  const analyticsTargets = settings?.analyticsTargets

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
    identifiedRef.current = false
    return currentInstance
  }, [shareAnalytics, analyticsTargets])

  // Build userId
  const userId = useMemo(() => {
    if (!tenantId) return null
    if (isAuthMode && user?.id) return `${tenantId}:${user.id}`
    return tenantId
  }, [tenantId, isAuthMode, user?.id])

  // Identify on instance creation or user change
  useEffect(() => {
    if (!instance || !userId || identifiedRef.current) return
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
    identifiedRef.current = true
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

  const identify = useCallback(() => {
    if (!instance || !userId) return
    const metadata = getAnalyticsMetadata()
    instance.identify(userId, {
      ...metadata,
      tenantId: tenantId!,
    })
  }, [instance, userId, tenantId])

  const value = useMemo<AnalyticsContextValue>(() => ({ track, identify }), [track, identify])

  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>
}

export function useAnalyticsTracking() {
  const context = useContext(AnalyticsContext)
  if (!context) {
    throw new Error('useAnalyticsTracking must be used within an AnalyticsProvider')
  }
  return context
}
