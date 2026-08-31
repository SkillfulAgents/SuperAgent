import { lt, parse } from 'semver'

export interface SidebarVersionState {
  showPair: boolean
  desktopBehind: boolean
  cloudBehind: boolean
  desktopWayBehind: boolean
  cloudWayBehind: boolean
  desktopVersion: string
  cloudVersion: string | null
}

/** Core `x.y.z` plus an optional prerelease. Build metadata is rejected. */
function parseVersion(raw: string) {
  const parsed = parse(raw.trim())
  if (!parsed || parsed.build.length > 0) return null
  return parsed
}

function isBehind(version: string, latest: string): boolean {
  const parsed = parseVersion(version)
  const parsedLatest = parseVersion(latest)
  if (!parsed || !parsedLatest) return false
  return lt(parsed, parsedLatest)
}

function isMajorMinorBehind(version: string, latest: string): boolean {
  const parsed = parseVersion(version)
  const parsedLatest = parseVersion(latest)
  if (!parsed || !parsedLatest) return false
  return parsed.major < parsedLatest.major || (parsed.major === parsedLatest.major && parsed.minor < parsedLatest.minor)
}

/**
 * Decide how the sidebar footer version chip renders in Electron + cloud.
 * `feedVersion` is the updater's channel latest when it has one (prerelease
 * setting already applied). When it is omitted, latest is the desktop build.
 */
export function resolveSidebarVersionState(input: {
  desktopVersion: string
  cloudVersion?: string
  feedVersion?: string
}): SidebarVersionState {
  const desktopVersion = input.desktopVersion
  const rawCloud = input.cloudVersion || null
  const cloudVersion = rawCloud && parseVersion(rawCloud) ? rawCloud : null
  const latest = input.feedVersion || desktopVersion

  const desktopBehind = isBehind(desktopVersion, latest)
  const cloudBehind = cloudVersion !== null && isBehind(cloudVersion, latest)
  const desktopWayBehind = isMajorMinorBehind(desktopVersion, latest)
  const cloudWayBehind = cloudVersion !== null && isMajorMinorBehind(cloudVersion, latest)
  const anyoneBehind = desktopBehind || cloudBehind
  const versionsDiffer = cloudVersion !== null && cloudVersion !== desktopVersion

  return {
    showPair: cloudVersion !== null && (versionsDiffer || anyoneBehind),
    desktopBehind,
    cloudBehind,
    desktopWayBehind,
    cloudWayBehind,
    desktopVersion,
    cloudVersion,
  }
}
