import { useEffect, useRef, useState } from 'react'
import { ContainerSetupDialog } from '@renderer/components/settings/container-setup-dialog'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { useSettings } from '@renderer/hooks/use-settings'
import { canUseHostFeatures } from '@renderer/lib/host-features'

/**
 * Owns the container-setup dialog lifecycle independently of the sidebar so
 * its open state survives navigating into full-page settings.
 */
export function ContainerSetupHandler() {
  const [open, setOpen] = useState(false)
  // The dialog offers to start a runner and links to the Docker Desktop
  // download, i.e. it asks you to fix *this* computer. Runtime readiness is
  // reported by whichever Superagent is being driven, so in cloud mode an
  // outage in the organization's workspace would otherwise pop a modal on every
  // desktop telling people to install Docker on their laptop. The sidebar
  // banner still reports the outage — that part is true wherever it comes from.
  const canSetUpRuntime = canUseHostFeatures()
  const { data: userSettings } = useUserSettings()
  const { data: runtimeStatus } = useRuntimeStatus()
  const { data: settings } = useSettings()
  const hasShownInitialSetup = useRef(false)

  const readiness = runtimeStatus?.runtimeReadiness
  const isRuntimeUnavailable = readiness?.status === 'RUNTIME_UNAVAILABLE' || readiness?.status === 'ERROR'
  const availability = settings?.runnerAvailability
  // Only auto-open when no runner can actually run — a failed Apple install
  // while Docker is still available must not force this modal.
  const anyRunnerAvailable = availability?.some((r) => r.available) ?? false
  const availabilityKnown = Array.isArray(availability)

  // Auto-open on first load if runtime is unavailable. Skip until the wizard is done — it covers runtime setup.
  useEffect(() => {
    if (
      canSetUpRuntime &&
      isRuntimeUnavailable &&
      availabilityKnown &&
      !anyRunnerAvailable &&
      !hasShownInitialSetup.current &&
      userSettings?.setupCompleted
    ) {
      hasShownInitialSetup.current = true
      setOpen(true)
    }
  }, [
    canSetUpRuntime,
    isRuntimeUnavailable,
    availabilityKnown,
    anyRunnerAvailable,
    userSettings?.setupCompleted,
  ])

  if (!canSetUpRuntime) return null

  return <ContainerSetupDialog open={open} onOpenChange={setOpen} />
}
