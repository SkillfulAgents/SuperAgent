/**
 * Team directories: a workspace's people as another system lists them (Slack
 * first). Gamut asks each connected directory for everyone in it, caches the
 * list, and does all searching, merging and ranking itself, so a provider only
 * lists people (and, optionally, messages them).
 *
 * Nothing outside `providers/` may know which provider it is talking to: a
 * second provider implements `TeamDirectoryProvider` and registers itself.
 */
import type { z } from 'zod'

/** One person as a directory lists them. Bots, guests and deactivated accounts are never listed. */
export interface DirectoryUser {
  provider: string
  /** The directory's workspace (Slack team or enterprise id). */
  tenantId: string
  /** The person's id in that workspace. */
  remoteId: string
  name: string
  email?: string
  /** Whether the provider vouches that `email` is the person's. Only a verified email merges people or names a Gamut account. */
  emailVerified: boolean
  avatarUrl?: string
}

/** What `notifyUser` sends: a short notice with a link back into Gamut. */
export interface DirectoryMessage {
  text: string
  url?: string
}

/** A connected directory, opened with its credentials. */
export interface TeamDirectory {
  /** Everyone in the directory. Filtering happens in Gamut, never in the provider. */
  listUsers(): Promise<DirectoryUser[]>
  /** Sends a person a message outside Gamut (a Slack DM). Absent when the provider cannot. */
  notifyUser?(user: DirectoryUser, message: DirectoryMessage): Promise<void>
}

/** A field of a provider's connect form. */
export interface DirectoryCredentialField {
  key: string
  label: string
  placeholder?: string
  /** Rendered as a password input. */
  secret?: boolean
}

/** What the Settings tab shows for a provider: the renderer draws the form from this alone. */
export interface DirectoryProviderInfo {
  id: string
  label: string
  description: string
  fields: DirectoryCredentialField[]
  /** How to get the credentials, in order. */
  steps: string[]
  /** A page that does most of the setup (Slack's "create an app" with a manifest). */
  setupLink?: { label: string; href: string }
}

/** What verifying credentials learned about the workspace they open. */
export interface DirectoryTenant {
  tenantId: string
  tenantName: string
}

export interface StoredDirectoryConnection<C> {
  id: string
  tenantId: string
  credentials: C
}

/**
 * A kind of directory. Registered once (`registry.ts`); everything that uses a
 * directory goes through this, so a new provider needs nothing else.
 */
export interface TeamDirectoryProvider<C = unknown> {
  info: DirectoryProviderInfo
  /** What the connect form posts; stored sealed. */
  credentialsSchema: z.ZodType<C>
  /**
   * Checks the credentials and names their workspace. Throws
   * `DirectoryConnectError` with a message for the admin when they cannot be used.
   */
  verify(credentials: C): Promise<DirectoryTenant>
  open(connection: StoredDirectoryConnection<C>): TeamDirectory
}

/** Credentials a provider refused, with a message an admin can act on. */
export class DirectoryConnectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirectoryConnectError'
  }
}
