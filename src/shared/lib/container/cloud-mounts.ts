import type { AgentMount } from '@shared/lib/types/mount'
import { storageSubPath } from '@shared/lib/config/data-dir'

/**
 * The MicroVM supervisor validates the whole volumes list and refuses the run
 * hook on one bad entry, so every rule it applies is applied here first and a
 * record that would fail there is dropped and reported instead. Same values
 * as supervisor.py: _VOLUME_NAME_RE, _SUBPATH_RE, _MAX_VOLUMES.
 */
const VOLUME_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const SUBPATH_RE = /^[A-Za-z0-9._/-]{1,256}$/
const MAX_CLOUD_MOUNTS = 32

/**
 * What a cloud runtime (k8s, MicroVM) may bind: an app-managed record under
 * /volumes/<name> whose host path sits in the shared volumes area of the org
 * disk. Anything else (a host folder from a desktop install, a path outside
 * the data dir, another agent's workspace inside it, a name or sub-path the
 * supervisor refuses, a second record with the same name, one past the count
 * limit) is dropped and reported. Both ends are checked because neither alone
 * proves ownership: the container path is what the record claims, the host
 * path is what it would actually expose.
 */
export function acceptCloudMounts(mounts: AgentMount[]): { accepted: Array<AgentMount & { subPath: string }>; dropped: AgentMount[] } {
  const accepted: Array<AgentMount & { subPath: string }> = []
  const dropped: AgentMount[] = []
  const names = new Set<string>()
  for (const mount of mounts) {
    const name = mount.containerPath.startsWith('/volumes/') ? mount.containerPath.slice('/volumes/'.length) : null
    const subPath = name && VOLUME_NAME_RE.test(name) && !names.has(name) && accepted.length < MAX_CLOUD_MOUNTS
      ? storageSubPath(mount.hostPath)
      : null
    if (subPath?.startsWith('volumes/') && SUBPATH_RE.test(subPath)) {
      names.add(name!)
      accepted.push({ ...mount, subPath })
    } else {
      dropped.push(mount)
    }
  }
  return { accepted, dropped }
}
