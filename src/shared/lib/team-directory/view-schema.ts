/** What the Team directory settings tab reads and sends. Shared with the renderer. */
import type { DirectoryProviderInfo } from './types'

export type { DirectoryCredentialField, DirectoryProviderInfo } from './types'

export interface TeamDirectoryView {
  id: string
  provider: string
  providerLabel: string
  /** The workspace: "Acme". */
  tenantName: string
  status: 'active' | 'error'
  /** Why the last listing failed, for the admin. */
  errorMessage: string | null
  /** Who connected it (auth mode); null once they are removed, and in local mode. */
  connectedBy: string | null
  connectedAt: number
}

export interface TeamDirectoriesResponse {
  providers: DirectoryProviderInfo[]
  directories: TeamDirectoryView[]
}

export type RefreshDirectoryResponse =
  | { ok: true; userCount: number; directory: TeamDirectoryView }
  | { ok: false; error: string; directory: TeamDirectoryView }
