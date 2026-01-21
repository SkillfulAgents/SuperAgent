import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { connectedAccounts } from '@/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import { getProvider } from '@/lib/composio/providers'

// GET /api/connected-accounts - List all app-level connected accounts
export async function GET() {
  try {
    const accounts = await db
      .select()
      .from(connectedAccounts)
      .orderBy(desc(connectedAccounts.createdAt))

    // Enrich with provider info
    const enriched = accounts.map((account) => ({
      ...account,
      provider: getProvider(account.toolkitSlug),
    }))

    return NextResponse.json({ accounts: enriched })
  } catch (error) {
    console.error('Failed to fetch connected accounts:', error)
    return NextResponse.json(
      { error: 'Failed to fetch connected accounts' },
      { status: 500 }
    )
  }
}

// POST /api/connected-accounts - Create a new connected account record
// This is called after OAuth callback to save the account to our DB
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { composioConnectionId, toolkitSlug, displayName } = body

    if (!composioConnectionId || !toolkitSlug || !displayName) {
      return NextResponse.json(
        { error: 'Missing required fields: composioConnectionId, toolkitSlug, displayName' },
        { status: 400 }
      )
    }

    const id = crypto.randomUUID()
    const now = new Date()

    await db.insert(connectedAccounts).values({
      id,
      composioConnectionId,
      toolkitSlug,
      displayName,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })

    const [created] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, id))
      .limit(1)

    return NextResponse.json({ account: { ...created, provider: getProvider(toolkitSlug) } })
  } catch (error: any) {
    console.error('Failed to create connected account:', error)

    // Handle unique constraint violation
    if (error.message?.includes('UNIQUE constraint failed')) {
      return NextResponse.json(
        { error: 'This connection already exists' },
        { status: 409 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to create connected account' },
      { status: 500 }
    )
  }
}
