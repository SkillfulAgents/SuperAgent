import { useEffect, useRef, useState } from 'react'
import { ContainerSetupDialog } from '@renderer/components/settings/container-setup-dialog'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'

/**
 * Owns the container-setup dialog lifecycle independently of the sidebar so
 * its open state survives navigating into full-page settings.
 */
export function ContainerSetupHandler() {
  const [open, setOpen] = useState(false)
  const { data: userSettings } = useUserSettings()
  const { data: runtimeStatus } = useRuntimeStatus()
  const hasShownInitialSetup = useRef(false)

  const readiness = runtimeStatus?.runtimeReadiness
  const isRuntimeUnavailable = readiness?.status === 'RUNTIME_UNAVAILABLE' || readiness?.status === 'ERROR'

  // Auto-open on first load if runtime is unavailable. Skip until the wizard is done — it covers runtime setup.
  useEffect(() => {
    if (isRuntimeUnavailable && !hasShownInitialSetup.current && userSettings?.setupCompleted) {
      hasShownInitialSetup.current = true
      setOpen(true)
    }
  }, [isRuntimeUnavailable, userSettings?.setupCompleted])

  return <ContainerSetupDialog open={open} onOpenChange={setOpen} />
}
