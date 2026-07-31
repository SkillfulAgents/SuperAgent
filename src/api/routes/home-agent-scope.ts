import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { getViewerUserId } from '@shared/lib/auth/ownership'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { listAgentSlugs } from '@shared/lib/services/agent-service'

export interface HomeAgentScope {
  agentSlugs: string[]
  userId: string | null
}

/** Match GET /api/agents visibility for home-page aggregate endpoints. */
export async function getHomeAgentScope(c: Context): Promise<HomeAgentScope> {
  const userId = getViewerUserId(c)
  if (userId === null) {
    // Slugs only — listAgents() would parse every agent's CLAUDE.md just to
    // throw the result away.
    return { agentSlugs: await listAgentSlugs(), userId }
  }

  const rows = await db
    .select({ agentSlug: agentAcl.agentSlug })
    .from(agentAcl)
    .where(eq(agentAcl.userId, userId))
  return { agentSlugs: rows.map((row) => row.agentSlug), userId }
}
