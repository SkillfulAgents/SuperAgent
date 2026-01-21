import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { connectedAccounts, agentConnectedAccounts } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getProvider } from '@/lib/composio/providers'
import { deleteConnection } from '@/lib/composio/client'

interface RouteParams {
  params: Promise<{ id: string }>
}

// GET /api/connected-accounts/[id] - Get a specific connected account
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params

    const [account] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, id))
      .limit(1)

    if (!account) {
      return NextResponse.json(
        { error: 'Connected account not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      account: { ...account, provider: getProvider(account.toolkitSlug) },
    })
  } catch (error) {
    console.error('Failed to fetch connected account:', error)
    return NextResponse.json(
      { error: 'Failed to fetch connected account' },
      { status: 500 }
    )
  }
}

// PUT /api/connected-accounts/[id] - Update a connected account
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params
    const body = await request.json()
    const { displayName, status } = body

    const [existing] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, id))
      .limit(1)

    if (!existing) {
      return NextResponse.json(
        { error: 'Connected account not found' },
        { status: 404 }
      )
    }

    await db
      .update(connectedAccounts)
      .set({
        ...(displayName && { displayName }),
        ...(status && { status }),
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, id))

    const [updated] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, id))
      .limit(1)

    return NextResponse.json({
      account: { ...updated, provider: getProvider(updated.toolkitSlug) },
    })
  } catch (error) {
    console.error('Failed to update connected account:', error)
    return NextResponse.json(
      { error: 'Failed to update connected account' },
      { status: 500 }
    )
  }
}

// DELETE /api/connected-accounts/[id] - Delete a connected account
// This cascades to delete all agent mappings
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params

    const [existing] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, id))
      .limit(1)

    if (!existing) {
      return NextResponse.json(
        { error: 'Connected account not found' },
        { status: 404 }
      )
    }

    // Try to delete from Composio (ignore errors if already deleted)
    try {
      await deleteConnection(existing.composioConnectionId)
    } catch (error) {
      console.warn('Failed to delete connection from Composio:', error)
    }

    // Delete from our DB (cascades to agent_connected_accounts)
    await db.delete(connectedAccounts).where(eq(connectedAccounts.id, id))

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to delete connected account:', error)
    return NextResponse.json(
      { error: 'Failed to delete connected account' },
      { status: 500 }
    )
  }
}
