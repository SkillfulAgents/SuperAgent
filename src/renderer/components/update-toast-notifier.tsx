import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useUpdateStatus } from '@renderer/context/update-status-context'

export function UpdateToastNotifier() {
  const status = useUpdateStatus()
  const lastToastedVersion = useRef<string | null>(null)
  const toastIdRef = useRef<string | number | null>(null)

  useEffect(() => {
    const onDismiss = () => { toastIdRef.current = null }

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
        description: 'A new version of Superagent is ready to download.',
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
      toast(`Version ${status.version ?? ''} is ready to install`, {
        id: toastIdRef.current,
        description: 'Restart Superagent to apply the update.',
        duration: Infinity,
        closeButton: true,
        onDismiss,
        action: {
          label: 'Restart & Update',
          onClick: () => window.electronAPI?.installUpdate(),
        },
      })
    }
  }, [status.state, status.version, status.progress])

  return null
}
