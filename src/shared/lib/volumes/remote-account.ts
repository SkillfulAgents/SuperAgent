import { eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { connectedAccounts } from '@shared/lib/db/schema'
import { getProvider } from '@shared/lib/account-providers/service-catalog'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'

/** The connected account a remote volume uses: it exists, is that toolkit, is active,
 * and belongs to the creator when one is given. */
export async function requireAccount(accountId: string, toolkit: string, creator?: { userId: string | null }) {
  const label = getProvider(toolkit)?.displayName ?? toolkit
  const account = await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, accountId)).get()
  if (!account || account.toolkitSlug !== toolkit || (creator?.userId && account.userId !== creator.userId)) {
    throw new WorkspaceFileError('not-found', `${label} account not found`)
  }
  if (account.status !== 'active') throw new WorkspaceFileError('not-accessible', `Reconnect this ${label} account in Connections`)
  return account
}
