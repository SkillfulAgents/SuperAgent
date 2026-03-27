import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { Authenticated, OwnsAccountByParam, OwnsMcpByParam } from '../middleware/auth'
import { db } from '@shared/lib/db'
import { apiScopePolicies, mcpToolPolicies } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'

const VALID_DECISIONS = ['allow', 'review', 'block'] as const
type ValidDecision = (typeof VALID_DECISIONS)[number]

function isValidDecision(d: unknown): d is ValidDecision {
  return typeof d === 'string' && (VALID_DECISIONS as readonly string[]).includes(d)
}

const policies = new Hono()

policies.use('*', Authenticated())

// GET /api/policies/scope/:accountId - List scope policies for an account
policies.get('/scope/:accountId', OwnsAccountByParam('accountId'), async (c) => {
  const accountId = c.req.param('accountId')
  const rows = db
    .select()
    .from(apiScopePolicies)
    .where(eq(apiScopePolicies.accountId, accountId))
    .all()
  return c.json({ policies: rows })
})

// PUT /api/policies/scope/:accountId - Replace all scope policies (batch)
policies.put('/scope/:accountId', OwnsAccountByParam('accountId'), async (c) => {
  const accountId = c.req.param('accountId')
  const body = await c.req.json<{
    policies: Array<{ scope: string; decision: string }>
  }>()

  if (!Array.isArray(body.policies) || body.policies.length > 500) {
    return c.json({ error: 'Invalid policies array (max 500)' }, 400)
  }

  const validated: Array<{ scope: string; decision: ValidDecision }> = []
  for (const p of body.policies) {
    if (!p.scope || typeof p.scope !== 'string') {
      return c.json({ error: `Invalid scope: ${JSON.stringify(p.scope)}` }, 400)
    }
    if (!isValidDecision(p.decision)) {
      return c.json({ error: `Invalid decision for scope "${p.scope}": ${p.decision}` }, 400)
    }
    validated.push({ scope: p.scope, decision: p.decision })
  }

  const now = new Date()
  db.transaction(() => {
    db.delete(apiScopePolicies).where(eq(apiScopePolicies.accountId, accountId)).run()
    for (const p of validated) {
      db.insert(apiScopePolicies).values({
        id: randomUUID(),
        accountId,
        scope: p.scope,
        decision: p.decision,
        createdAt: now,
        updatedAt: now,
      }).run()
    }
  })

  return c.json({ ok: true })
})

// GET /api/policies/tool/:mcpId - List tool policies for an MCP server
policies.get('/tool/:mcpId', OwnsMcpByParam('mcpId'), async (c) => {
  const mcpId = c.req.param('mcpId')
  const rows = db
    .select()
    .from(mcpToolPolicies)
    .where(eq(mcpToolPolicies.mcpId, mcpId))
    .all()
  return c.json({ policies: rows })
})

// PUT /api/policies/tool/:mcpId - Replace all tool policies (batch)
policies.put('/tool/:mcpId', OwnsMcpByParam('mcpId'), async (c) => {
  const mcpId = c.req.param('mcpId')
  const body = await c.req.json<{
    policies: Array<{ toolName: string; decision: string }>
  }>()

  if (!Array.isArray(body.policies) || body.policies.length > 500) {
    return c.json({ error: 'Invalid policies array (max 500)' }, 400)
  }

  const validated: Array<{ toolName: string; decision: ValidDecision }> = []
  for (const p of body.policies) {
    if (!p.toolName || typeof p.toolName !== 'string') {
      return c.json({ error: `Invalid toolName: ${JSON.stringify(p.toolName)}` }, 400)
    }
    if (!isValidDecision(p.decision)) {
      return c.json({ error: `Invalid decision for tool "${p.toolName}": ${p.decision}` }, 400)
    }
    validated.push({ toolName: p.toolName, decision: p.decision })
  }

  const now = new Date()
  db.transaction(() => {
    db.delete(mcpToolPolicies).where(eq(mcpToolPolicies.mcpId, mcpId)).run()
    for (const p of validated) {
      db.insert(mcpToolPolicies).values({
        id: randomUUID(),
        mcpId,
        toolName: p.toolName,
        decision: p.decision,
        createdAt: now,
        updatedAt: now,
      }).run()
    }
  })

  return c.json({ ok: true })
})

export default policies
