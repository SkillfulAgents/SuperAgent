import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agents } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { containerManager } from '@/lib/container/container-manager'

// POST /api/agents/[id]/stop - Stop an agent's container
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // Get agent from database
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1)

    if (agent.length === 0) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // Get container client
    const client = containerManager.getClient(id)

    // Check if already stopped via Docker
    const info = await client.getInfo()
    if (info.status === 'stopped') {
      return NextResponse.json({
        ...agent[0],
        status: 'stopped',
        containerPort: null,
        message: 'Agent is already stopped',
      })
    }

    // Stop the container
    await client.stop()

    // Update timestamp
    await db
      .update(agents)
      .set({ updatedAt: new Date() })
      .where(eq(agents.id, id))

    const updated = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1)

    return NextResponse.json({
      ...updated[0],
      status: 'stopped',
      containerPort: null,
    })
  } catch (error: any) {
    console.error('Failed to stop agent:', error)
    return NextResponse.json(
      { error: 'Failed to stop agent', details: error.message },
      { status: 500 }
    )
  }
}
