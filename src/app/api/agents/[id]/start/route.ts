import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agents } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { containerManager } from '@/lib/container/container-manager'

// POST /api/agents/[id]/start - Start an agent's container
export async function POST(
  _request: NextRequest,
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

    // Ensure container is running (fetches secrets and starts if needed)
    const client = await containerManager.ensureRunning(id)

    // Get updated status from Docker
    const newInfo = await client.getInfo()

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
      status: newInfo.status,
      containerPort: newInfo.port,
    })
  } catch (error: any) {
    console.error('Failed to start agent:', error)
    return NextResponse.json(
      { error: 'Failed to start agent', details: error.message },
      { status: 500 }
    )
  }
}
