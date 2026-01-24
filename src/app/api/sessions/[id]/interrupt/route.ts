import { NextRequest, NextResponse } from 'next/server'
import { containerManager } from '@/lib/container/container-manager'
import { messagePersister } from '@/lib/container/message-persister'
import { findSessionAcrossAgents } from '@/lib/services/session-service'

// POST /api/sessions/[id]/interrupt - Interrupt an active session
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: sessionId } = await params

    // Find which agent this session belongs to
    const result = await findSessionAcrossAgents(sessionId)

    if (!result) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    const { agentSlug } = result

    // Get container client
    const client = containerManager.getClient(agentSlug)

    // Check if container is running
    const info = await client.getInfo()
    if (info.status !== 'running') {
      return NextResponse.json(
        { error: 'Agent container is not running' },
        { status: 400 }
      )
    }

    // Interrupt the session in the container
    // Note: Session ID is the same as container session ID in the new model
    const interrupted = await client.interruptSession(sessionId)

    if (!interrupted) {
      return NextResponse.json(
        { error: 'Failed to interrupt session' },
        { status: 500 }
      )
    }

    // Mark the session as interrupted in the message persister
    await messagePersister.markSessionInterrupted(sessionId)

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    console.error('Failed to interrupt session:', error)
    return NextResponse.json(
      { error: 'Failed to interrupt session' },
      { status: 500 }
    )
  }
}
