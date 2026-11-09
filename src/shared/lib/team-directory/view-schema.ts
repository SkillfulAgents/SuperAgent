/** What the Team directory settings tab reads and sends. Shared with the renderer. */
import { z } from 'zod'
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
  provisioning?: Omit<DirectoryProviderInfo, 'id' | 'label'> & {
    /** Those credentials alone connect the directory: Gamut creates its app, a person installs it. */
    connectsDirectory?: boolean
  }
}

/** POST /api/team-directories/install: the provider's page that installs the directory's new app. */
export interface StartDirectoryInstallResponse {
  installId: string
  url: string
}

/** How an install went, as the host records it (`directory-app.ts`). */
export const directoryInstallOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('connected'), directoryId: z.string(), tenantName: z.string(), notices: z.array(z.string()) }),
  /** Declined on the provider's page; the same install can be tried again. `at` tells one cancel from the next. */
  z.object({ status: z.literal('cancelled'), at: z.number() }),
  z.object({ status: z.literal('failed'), error: z.string() }),
])

/** GET /api/team-directories/install/:installId: the outcome, or `expired` once the install can't finish any more. */
export type DirectoryInstallStatus = z.infer<typeof directoryInstallOutcomeSchema> | { status: 'expired' }

/** DELETE /api/team-directories/:id */
export interface DisconnectDirectoryResponse {
  /** The app Gamut made for the directory stays, because it can't be deleted (no app-creation credentials left). */
  appLeftBehind: boolean
}

export interface TeamDirectoriesResponse {
  providers: DirectoryProviderView[]
  directories: TeamDirectoryView[]
}

export type RefreshDirectoryResponse =
  | { ok: true; userCount: number; directory: TeamDirectoryView }
  | { ok: false; error: string; directory: TeamDirectoryView }
