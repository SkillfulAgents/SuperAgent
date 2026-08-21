import { getSettings, mutateSettings, type CloudWorkspaceSettings } from '@shared/lib/config/settings'
import { CloudWorkspaceSettingsSchema } from '@shared/lib/types/skillset-schema'
import { captureException } from '@shared/lib/error-reporting'

// Persistence for the maintained cloud-workspace deployment token. Kept free of
// service/client imports so `platform-auth-service` can clear the record on
// disconnect without a module cycle.

export function readCloudWorkspaceRecord(): CloudWorkspaceSettings | null {
  const raw = getSettings().cloudWorkspace
  if (!raw) return null
  // Validate at the boundary; a corrupt settings.json shouldn't crash callers,
  // but we do want it visible in Sentry.
  const parsed = CloudWorkspaceSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    captureException(parsed.error, { tags: { area: 'cloud-workspace', op: 'read' } })
    return null
  }
  return parsed.data
}

export function writeCloudWorkspaceRecord(record: CloudWorkspaceSettings): void {
  // Serialized fresh-read + atomic write so a background refresh can't
  // lose-update a concurrent settings change.
  const validated = CloudWorkspaceSettingsSchema.parse(record)
  mutateSettings((settings) => {
    settings.cloudWorkspace = validated
  })
}

let onRecordCleared: ((deploymentUrl: string) => void) | null = null

/** Main registers this to drop the planted dashboard cookie. Shared code stays Electron-free. */
export function setCloudWorkspaceRecordClearedListener(
  listener: ((deploymentUrl: string) => void) | null,
): void {
  onRecordCleared = listener
}

export function clearCloudWorkspaceRecord(): void {
  const existing = getSettings().cloudWorkspace
  if (!existing) return
  const url = existing.deploymentUrl
  mutateSettings((settings) => {
    settings.cloudWorkspace = undefined
  })
  if (url) onRecordCleared?.(url)
}

/** Short, non-sensitive preview of a token for display/logging. */
export function buildCloudWorkspaceTokenPreview(token: string): string {
  if (token.length <= 12) return token
  return `${token.slice(0, 6)}...${token.slice(-4)}`
}
