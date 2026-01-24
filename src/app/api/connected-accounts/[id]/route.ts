import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { connectedAccounts } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { deleteConnection } from '@/lib/composio/client'

interface RouteParams {
  params: Promise<{ id: string }>
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
