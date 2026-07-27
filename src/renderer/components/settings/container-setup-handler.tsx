import { useEffect, useRef, useState } from 'react'
import { ContainerSetupDialog } from '@renderer/components/settings/container-setup-dialog'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { useSettings } from '@renderer/hooks/use-settings'
import { targetIsRemote } from '@renderer/lib/api-target'

/**
 * Owns the container-setup dialog lifecycle independently of the sidebar so
 * its open state survives navigating into full-page settings.
 */
export function ContainerSetupHandler() {
  const [open, setOpen] = useState(false)
  // The dialog starts a runner on the Superagent being driven and, on the
  // desktop, links to the Docker Desktop download — it asks you to fix the
  // machine you are set up on. Right for the desktop app and for a self-hosted
  // web deployment; wrong for a cloud workspace, where an outage in the
  // organization's runtime would otherwise pop this modal on every desktop in
  // the org, telling each person to install Docker on their laptop.
  //
  // `targetIsRemote()`, not `canUseHostFeatures()`: the latter is false in every
  // browser and would disable this for ordinary web deployments too.
  const canSetUpRuntime = !targetIsRemote()
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
