import path from 'path'
import { getVolumesDir } from '@shared/lib/config/data-dir'
import { getSettings } from '@shared/lib/config/settings'
import { SHARED_VOLUME_NAME_RE } from '@shared/lib/utils/shared-volume-name'
import type { AgentMount } from '@shared/lib/types/mount'

/**
 * Whether this server's agents take shared volumes instead of host folders: a
 * MicroVM cannot bind a folder from this machine, only a volume on the
 * workspace disk. The mounts API takes a name here and a folder path elsewhere.
 */
export function usesSharedVolumes(): boolean {
  return getSettings().container.containerRunner === 'lambda-microvm'
}

/**
 * Whether a mount row is a shared volume: `/mounts/<name>` backed by exactly
 * `volumes/<name>`, the row the shared-volume add writes. The VM mounts a row
 * by its `/mounts` name alone, so only these may reach it.
 */
export function isSharedVolumeMount(mount: AgentMount): boolean {
  const name = mount.containerPath.startsWith('/mounts/') ? mount.containerPath.slice('/mounts/'.length) : ''
  return SHARED_VOLUME_NAME_RE.test(name) && mount.hostPath === path.join(getVolumesDir(), name)
}
