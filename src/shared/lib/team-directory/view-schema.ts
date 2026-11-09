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
  /** Creating agents' own apps through it; absent when its provider can't. */
  provisioning?: {
    /** null: no credentials added yet. */
    status: 'active' | 'needs_reconnect' | null
    error: string | null
  }
}

/** A provider, and the form for its app-creation credentials when it has one. */
export type DirectoryProviderView = DirectoryProviderInfo & {
  provisioning?: Omit<DirectoryProviderInfo, 'id' | 'label'>
}

export interface TeamDirectoriesResponse {
  providers: DirectoryProviderView[]
  directories: TeamDirectoryView[]
}

export type RefreshDirectoryResponse =
  | { ok: true; userCount: number; directory: TeamDirectoryView }
  | { ok: false; error: string; directory: TeamDirectoryView }
