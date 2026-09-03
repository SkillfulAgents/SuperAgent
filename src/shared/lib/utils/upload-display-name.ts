/**
 * Uploads are stored as `<epoch ms>-<original name>` (see the upload route),
 * which keeps names unique but is noise to the user. These helpers give back
 * the name they attached wherever a stored path is shown.
 */

import { getPathName } from './workspace-path'

const UPLOAD_PREFIX = /^\d{13}-/

/** `1788459888315-report.pdf` → `report.pdf`; other names pass through. */
export function stripUploadPrefix(name: string): string {
  return name.replace(UPLOAD_PREFIX, '')
}

/** Last path segment (trailing slash tolerated) with any upload prefix removed. */
export function displayNameForPath(filePath: string): string {
  return stripUploadPrefix(getPathName(filePath))
}
