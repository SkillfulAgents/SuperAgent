import { appVersionsMatch, formatAppVersion } from '@shared/lib/config/app-version'
import { useUpdateStatus } from '@renderer/context/update-status-context'

/** Sidebar version chip: local + cloud when connected; amber cue on drift. */
export function SidebarVersion({
  cloudVersion,
  cloudConnected,
  onOpenUpdates,
}: {
  /** Platform-discovered cloud deployment version, or null when unknown. */
  cloudVersion: string | null
  /** True when a cloud workspace is found (token optional for display). */
  cloudConnected: boolean
  onOpenUpdates: () => void
}) {
  const updateStatus = useUpdateStatus()
  const updateAvailable = updateStatus.state === 'available' || updateStatus.state === 'downloaded'
  const localLabel = formatAppVersion(__APP_VERSION__)
  const cloudLabel = cloudVersion ? formatAppVersion(cloudVersion) : null
  const drifted =
    cloudConnected && cloudLabel != null && !appVersionsMatch(__APP_VERSION__, cloudVersion!)

  let title: string | undefined
  if (drifted) {
    title = `Local ${localLabel} · Cloud ${cloudLabel}`
  } else if (updateAvailable) {
    title = `Update available: v${updateStatus.version}`
  } else if (cloudConnected && cloudLabel) {
    title = `Local and cloud: ${localLabel}`
  }

  return (
    <button
      type="button"
      onClick={onOpenUpdates}
      className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground shrink-0 hover:text-foreground"
      title={title}
      data-testid="sidebar-version"
    >
      {drifted ? (
        <span
          className="h-2 w-2 rounded-full bg-amber-500"
          aria-label="Cloud and local versions differ"
          data-testid="sidebar-version-drift"
        />
      ) : updateAvailable ? (
        <span className="h-2 w-2 rounded-full bg-blue-500" aria-label="Update available" />
      ) : null}
      <span>
        {localLabel}
        {cloudConnected && cloudLabel ? (
          <>
            {' · '}
            <span data-testid="sidebar-cloud-version">cloud {cloudLabel}</span>
          </>
        ) : null}
      </span>
    </button>
  )
}
