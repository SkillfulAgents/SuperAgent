import { eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { connectedAccounts } from '@shared/lib/db/schema'
import { getProvider } from '@shared/lib/account-providers/service-catalog'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { attribution, runWithAttribution } from '@shared/lib/platform-attribution'

type Account = Awaited<ReturnType<typeof requireAccount>>
type Operation = { account: Account; owner?: ReturnType<typeof attribution.fromResourceCreator> }
const currentOperation = new AsyncLocalStorage<Operation>()

/** Authorization is scoped to an operation, never cached between operations.
 * A commit explicitly refreshes it after staging bytes or waiting for a lock. */
export async function withRemoteAccount<T>(id: string, toolkit: string, run: (account: Account) => Promise<T>, refresh = false): Promise<T> {
  const current = currentOperation.getStore()
  if (!refresh && current?.account.id === id && current.account.toolkitSlug === toolkit) return run(current.account)
  const account = await requireAccount(id, toolkit)
  return currentOperation.run({ account }, () => run(account))
}

export async function withRemoteAttribution<T>(id: string, toolkit: string, run: (account: Account) => Promise<T>): Promise<T> {
  return withRemoteAccount(id, toolkit, async account => {
    const context = currentOperation.getStore()!
    const owner = await (context.owner ??= attribution.fromResourceCreator(account.userId))
    return runWithAttribution(owner, () => run(account))
  })
}

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
