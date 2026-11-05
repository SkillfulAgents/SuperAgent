import {
  getSettings,
  updateSettings,
  type AppSettings,
  type CloudWorkspaceSettings,
} from '@shared/lib/config/settings'
import { CloudWorkspaceSettingsSchema } from '@shared/lib/types/skillset-schema'
import { captureException } from '@shared/lib/error-reporting'

// Persistence for the maintained cloud-workspace deployment token. Kept free of
// service/client imports so `platform-auth-service` can clear the record on
// disconnect without a module cycle.

export interface CloudWorkspaceRecordWriteOptions {
  /**
   * Checked against the settings the write would replace, inside the same
   * compare-and-set: the write happens only when it returns true. Lets a caller
   * make "the account is still the one I minted for" and the write one step,
   * with no await between them. Runs inside a settings mutator (possibly more
   * than once), so it must be synchronous and free of side effects.
   */
  onlyIf?: (settings: Readonly<AppSettings>) => boolean
}

export async function readCloudWorkspaceRecord(): Promise<CloudWorkspaceSettings | null> {
  const raw = (await getSettings()).cloudWorkspace
  if (!raw) return null
  // Validate at the boundary; a corrupt stored record shouldn't crash callers,
  // but we do want it visible in Sentry.
  const parsed = CloudWorkspaceSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    captureException(parsed.error, { tags: { area: 'cloud-workspace', op: 'read' } })
    return null
  }
  return parsed.data
}

/** Store the record; resolves to whether it was written (false only when `onlyIf` refused). */
export async function writeCloudWorkspaceRecord(
  record: CloudWorkspaceSettings,
  options: CloudWorkspaceRecordWriteOptions = {},
): Promise<boolean> {
  // Compare-and-set write so a background refresh can't lose-update a
  // concurrent settings change.
  const validated = CloudWorkspaceSettingsSchema.parse(record)
  const { written } = await updateSettings((draft, before) => {
    if (options.onlyIf && !options.onlyIf(before)) return false
    draft.cloudWorkspace = validated
  })
  return written
}

export async function clearCloudWorkspaceRecord(options: CloudWorkspaceRecordWriteOptions = {}): Promise<void> {
  if (!(await getSettings()).cloudWorkspace) return
  await updateSettings((draft, before) => {
    // Cleared by someone else since the read above: nothing to write.
    if (!before.cloudWorkspace) return false
    if (options.onlyIf && !options.onlyIf(before)) return false
    draft.cloudWorkspace = undefined
  })
}

/** Short, non-sensitive preview of a token for display/logging. */
export function buildCloudWorkspaceTokenPreview(token: string): string {
  if (token.length <= 12) return token
  return `${token.slice(0, 6)}...${token.slice(-4)}`
}
