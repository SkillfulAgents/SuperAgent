import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agentConnectedAccounts } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'

interface RouteParams {
  params: Promise<{ id: string; accountId: string }>
}

// DELETE /api/agents/[id]/connected-accounts/[accountId] - Remove account mapping from agent
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: agentId, accountId } = await params

    // Find and delete the mapping
    const [existing] = await db
      .select()
      .from(agentConnectedAccounts)
      .where(
        and(
          eq(agentConnectedAccounts.agentId, agentId),
          eq(agentConnectedAccounts.connectedAccountId, accountId)
        )
      )
      .limit(1)

    if (!existing) {
      return NextResponse.json(
        { error: 'Account mapping not found' },
        { status: 404 }
      )
    }

    await db
      .delete(agentConnectedAccounts)
      .where(eq(agentConnectedAccounts.id, existing.id))

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to remove account mapping:', error)
    return NextResponse.json(
      { error: 'Failed to remove account mapping' },
      { status: 500 }
    )
  }
}
