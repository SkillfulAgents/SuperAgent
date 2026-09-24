/**
 * A shared volume's name: its folder under the volumes directory and its path
 * `/mounts/<name>` in the agent. The same rule as `_VOLUME_NAME_RE` in
 * gamut-infra microvm-agent-image/gamut_supervisor/mount.py, which receives it.
 */
export const SHARED_VOLUME_NAME_RE = /^[a-z0-9][a-z0-9-]{0,49}$/

