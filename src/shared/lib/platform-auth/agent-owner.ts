import { db } from '@shared/lib/db'
import { agentAcl, authAccount } from '@shared/lib/db/schema'
import { asc, desc, eq, and } from 'drizzle-orm'

// Resolve the billing-owner's external provider accountId for an agent.
//
// Semantics: "oldest still-present owner pays". We attribute LLM usage to
// the earliest `agentAcl` row with role=owner (ordered by createdAt ASC)
// that has a linked `authAccount` for the requested providerId. If that
// owner is removed/leaves, attribution naturally rolls to the next oldest
// remaining owner on the next query.
//
// No caching: this runs at container/session start (not per LLM call), the
// query is a single indexed row on local SQLite, and caching would only
// re-introduce the staleness problems we're trying to avoid after ACL
// mutations.
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
    .orderBy(asc(agentAcl.createdAt), desc(authAccount.updatedAt))
    .limit(1)
    .all()

  return rows[0]?.accountId ?? null
}

// Most recently refreshed platform account on this install. Used by
// Composio / Skills clients that need a member id but don't have a
// specific user or agent context (e.g. org-scoped JWT deployments).
export function getLatestPlatformAccountId(): string | null {
  const rows = db
    .select({ accountId: authAccount.accountId })
    .from(authAccount)
    .where(eq(authAccount.providerId, 'platform'))
    .orderBy(desc(authAccount.updatedAt))
    .limit(1)
    .all()

  return rows[0]?.accountId ?? null
}
