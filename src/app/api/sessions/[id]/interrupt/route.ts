import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sessions, agents } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { containerManager } from '@/lib/container/container-manager'
import { messagePersister } from '@/lib/container/message-persister'

// POST /api/sessions/[id]/interrupt - Interrupt an active session
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // Get session with agent
    const session = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1)

    if (session.length === 0) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    const sessionData = session[0]

    if (!sessionData.containerSessionId) {
      return NextResponse.json(
        { error: 'Session has no active container session' },
        { status: 400 }
      )
    }

    // Get agent
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, sessionData.agentId))
      .limit(1)

    if (agent.length === 0) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const agentData = agent[0]

    // Get container client
    const client = containerManager.getClient(agentData.id)

    // Check if container is running
    const info = await client.getInfo()
    if (info.status !== 'running') {
      return NextResponse.json(
        { error: 'Agent container is not running' },
        { status: 400 }
      )
    }

    // Interrupt the session in the container
    const interrupted = await client.interruptSession(sessionData.containerSessionId)

    if (!interrupted) {
      return NextResponse.json(
        { error: 'Failed to interrupt session' },
        { status: 500 }
      )
    }

    // Mark the session as interrupted in the message persister
    messagePersister.markSessionInterrupted(id)

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Failed to interrupt session:', error)
    return NextResponse.json(
      { error: 'Failed to interrupt session', details: error.message },
      { status: 500 }
    )
  }
}
