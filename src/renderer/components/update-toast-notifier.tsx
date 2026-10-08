import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useUpdateStatus } from '@renderer/context/update-status-context'
import { useUserSettings } from '@renderer/hooks/use-user-settings'

export function UpdateToastNotifier() {
  const status = useUpdateStatus()
  const { data: userSettings, isLoading: isUserSettingsLoading } = useUserSettings()
  const backgroundDownload = userSettings?.autoCheckUpdates !== false && !!userSettings?.preinstallUpdates
  const lastToastedVersion = useRef<string | null>(null)
  const toastIdRef = useRef<string | number | null>(null)

  useEffect(() => {
    if (isUserSettingsLoading) return
    const onDismiss = () => { toastIdRef.current = null }
    const showReadyToInstall = (version: string | undefined) => {
      toastIdRef.current = toast(`Version ${version ?? ''} is ready to install`, {
        id: toastIdRef.current ?? undefined,
        description: 'Restart Gamut to apply the update.',
        duration: Infinity,
        closeButton: true,
        onDismiss,
        action: {
          label: 'Restart & Update',
          onClick: () => window.electronAPI?.installUpdate(),
        },
      })
    }

    // Background download: stay quiet until the update and its image are ready.
    if (backgroundDownload) {
      if (status.state !== 'downloaded' || !status.version) return
      if (lastToastedVersion.current === status.version) return
      lastToastedVersion.current = status.version
      showReadyToInstall(status.version)
      return
    }

    if (status.state === 'available' && status.version) {
      // Only toast once per new version. If the user dismissed an earlier
      // toast for this version, don't re-show it.
      if (lastToastedVersion.current === status.version) return
      lastToastedVersion.current = status.version
      // Reuse the existing toast id if there's still one on screen, so a
      // newer version replaces the old toast in place rather than stacking.
      // toastIdRef is null after dismissal, so a fresh toast is created.
      toastIdRef.current = toast(`Version ${status.version} is available`, {
        id: toastIdRef.current ?? undefined,
        description: 'A new version of Gamut is ready to download.',
        duration: Infinity,
        closeButton: true,
        onDismiss,
        action: {
          label: 'Download',
          onClick: () => window.electronAPI?.downloadUpdate(),
        },
      })
      return
    }

    // Subsequent transitions update the existing toast in place. If the user
    // already dismissed it, stay quiet.
    if (toastIdRef.current === null) return

    if (status.state === 'downloading') {
      const pct = Math.round(status.progress ?? 0)
      toast(`Downloading${status.version ? ` version ${status.version}` : ''}`, {
        id: toastIdRef.current,
        description: `${pct}% complete`,
        duration: Infinity,
        closeButton: true,
        onDismiss,
      })
    } else if (status.state === 'downloaded') {
      showReadyToInstall(status.version)
    }
  }, [status.state, status.version, status.progress, isUserSettingsLoading, backgroundDownload])

  return null
}
