/**
 * Uploads are stored with a millisecond timestamp so repeat uploads never
 * collide: `report-1788459888315.pdf` (current form, timestamp after the
 * stem) or `1788459888315-report.pdf` (earlier builds). Either is noise to
 * the user, so these helpers give back the name they attached wherever a
 * stored path is shown.
 */

const SUFFIX = /-\d{13}(?=\.[^.]*$|$)/
const LEGACY_PREFIX = /^\d{13}-/

/** `report-1788459888315.pdf` → `report.pdf`; `1788459888315-report.pdf` → `report.pdf`; others pass through. */
export function stripUploadPrefix(name: string): string {
  return name.replace(SUFFIX, '').replace(LEGACY_PREFIX, '')
}

/** Last path segment (trailing slash tolerated) with any upload timestamp removed. */
export function displayNameForPath(filePath: string): string {
  const trimmed = filePath.replace(/\/+$/, '')
  const base = trimmed.split('/').pop() || filePath
  return stripUploadPrefix(base)
}
