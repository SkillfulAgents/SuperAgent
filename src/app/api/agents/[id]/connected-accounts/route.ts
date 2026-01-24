import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { connectedAccounts, agentConnectedAccounts } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getProvider } from '@/lib/composio/providers'
import { agentExists } from '@/lib/services/agent-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

// GET /api/agents/[id]/connected-accounts - List agent's connected accounts
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: slug } = await params

    // Verify agent exists
    if (!(await agentExists(slug))) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // Get agent's connected account mappings with full account info
    const mappings = await db
      .select({
        mapping: agentConnectedAccounts,
        account: connectedAccounts,
      })
      .from(agentConnectedAccounts)
      .innerJoin(
        connectedAccounts,
        eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id)
      )
      .where(eq(agentConnectedAccounts.agentSlug, slug))

    const accounts = mappings.map(({ mapping, account }) => ({
      ...account,
      mappingId: mapping.id,
      mappedAt: mapping.createdAt,
      provider: getProvider(account.toolkitSlug),
    }))

    return NextResponse.json({ accounts })
  } catch (error) {
    console.error('Failed to fetch agent connected accounts:', error)
    return NextResponse.json(
      { error: 'Failed to fetch agent connected accounts' },
      { status: 500 }
    )
  }
}

// POST /api/agents/[id]/connected-accounts - Map account(s) to agent
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: slug } = await params
    const body = await request.json()
    const { accountIds } = body as { accountIds: string[] }

    if (!accountIds || !Array.isArray(accountIds) || accountIds.length === 0) {
      return NextResponse.json(
        { error: 'Missing required field: accountIds (array)' },
        { status: 400 }
      )
    }

    // Verify agent exists
    if (!(await agentExists(slug))) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // Create mappings for each account
    const now = new Date()
    const mappings = accountIds.map((accountId) => ({
      id: crypto.randomUUID(),
      agentSlug: slug,
      connectedAccountId: accountId,
      createdAt: now,
    }))

    // Insert mappings (ignore duplicates)
    for (const mapping of mappings) {
      try {
        await db.insert(agentConnectedAccounts).values(mapping)
      } catch (error: unknown) {
        // Ignore duplicate mapping errors
        const message = error instanceof Error ? error.message : ''
        if (!message.includes('UNIQUE constraint failed')) {
          throw error
        }
      }
    }

    // Return updated list
    const updatedMappings = await db
      .select({
        mapping: agentConnectedAccounts,
        account: connectedAccounts,
      })
      .from(agentConnectedAccounts)
      .innerJoin(
        connectedAccounts,
        eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id)
      )
      .where(eq(agentConnectedAccounts.agentSlug, slug))

    const accounts = updatedMappings.map(({ mapping, account }) => ({
      ...account,
      mappingId: mapping.id,
      mappedAt: mapping.createdAt,
      provider: getProvider(account.toolkitSlug),
    }))

    return NextResponse.json({ accounts })
  } catch (error) {
    console.error('Failed to map connected accounts to agent:', error)
    return NextResponse.json(
      { error: 'Failed to map connected accounts to agent' },
      { status: 500 }
    )
  }
}
