/**
 * A shared volume's name: its folder under the volumes directory and its path
 * `/mounts/<name>` in the agent. The same rule as `_VOLUME_NAME_RE` in
 * gamut-infra microvm-agent-image/gamut_supervisor/mount.py, which receives it.
 * Lives apart from the server code so the renderer can convert names to it.
 */
export const SHARED_VOLUME_NAME_RE = /^[a-z0-9][a-z0-9-]{0,49}$/

/**
 * The volume name a person means by what they typed ("Team Brain" → `team-brain`),
 * or '' when nothing usable is left. The result always passes the rule.
 */
export function toSharedVolumeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 50)
    .replace(/-+$/, '')
}
