import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agents } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { containerManager } from '@/lib/container/container-manager'

// POST /api/agents/[id]/start - Start an agent's container
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

    // Get or create container client
    const client = containerManager.getClient(id)

    // Check if already running via Docker
    const info = await client.getInfo()
    if (info.status === 'running') {
      return NextResponse.json({
        ...agent[0],
        status: info.status,
        containerPort: info.port,
        message: 'Agent is already running',
      })
    }

    // Start the container
    await client.start()

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
