import { db } from '@shared/lib/db'
import { agentAcl, authAccount } from '@shared/lib/db/schema'
import { asc, desc, eq, and } from 'drizzle-orm'

const PLATFORM_PROVIDER_ID = 'platform'

/** Billing owner = oldest agentAcl(role=owner) row with a linked platform account. */
export function getOwnerAccountIdForProvider(agentSlug: string, providerId: string): string | null {
  const rows = db
    .select({ accountId: authAccount.accountId })
    .from(agentAcl)
    .innerJoin(
      authAccount,
      and(
        eq(authAccount.userId, agentAcl.userId),
        eq(authAccount.providerId, providerId),
      ),
    )
    .where(and(eq(agentAcl.agentSlug, agentSlug), eq(agentAcl.role, 'owner')))
    // userId tiebreaker keeps ordering stable when two owners share a ms timestamp.
    .orderBy(
      asc(agentAcl.createdAt),
      asc(agentAcl.userId),
      desc(authAccount.updatedAt),
    )
    .limit(1)
    .all()

  return rows[0]?.accountId ?? null
}

export function getPlatformAccountIdForUserId(userId: string): string | null {
  const rows = db
    .select({ accountId: authAccount.accountId })
    .from(authAccount)
    .where(
      and(
        eq(authAccount.userId, userId),
        eq(authAccount.providerId, PLATFORM_PROVIDER_ID),
      ),
    )
    .orderBy(desc(authAccount.updatedAt))
    .limit(1)
    .all()

  return rows[0]?.accountId ?? null
}
