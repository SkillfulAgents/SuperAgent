import { formatAppVersion } from '@shared/lib/config/app-version'
import { useUpdateStatus } from '@renderer/context/update-status-context'

/** Sidebar version chip: local build, or cloud deployment version when driving cloud. */
export function SidebarVersion({
  drivingCloud,
  cloudVersion,
  onOpenUpdates,
}: {
  /** True when this window is driving the cloud workspace. */
  drivingCloud: boolean
  /** Platform-discovered cloud deployment version, or null when unknown. */
  cloudVersion: string | null
  onOpenUpdates: () => void
}) {
  const updateStatus = useUpdateStatus()
  const updateAvailable = updateStatus.state === 'available' || updateStatus.state === 'downloaded'
  const localLabel = formatAppVersion(__APP_VERSION__)
  const cloudLabel = cloudVersion ? formatAppVersion(cloudVersion) : null
  const label = drivingCloud && cloudLabel ? cloudLabel : localLabel

  let title: string | undefined
  if (updateAvailable) {
    title = `Update available: v${updateStatus.version}`
  } else if (drivingCloud && cloudLabel) {
    title = `Cloud workspace ${cloudLabel}`
  }

  return (
    <button
      type="button"
      onClick={onOpenUpdates}
      className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground shrink-0 hover:text-foreground"
      title={title}
      data-testid="sidebar-version"
    >
      {updateAvailable && (
        <span className="h-2 w-2 rounded-full bg-blue-500" aria-label="Update available" />
      )}
      <span>
        {drivingCloud && cloudLabel ? (
          <span data-testid="sidebar-cloud-version">cloud {cloudLabel}</span>
        ) : (
          label
        )}
      </span>
    </button>
  )
}
