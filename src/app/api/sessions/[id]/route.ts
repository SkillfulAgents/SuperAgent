import { NextRequest, NextResponse } from 'next/server'
import { messagePersister } from '@/lib/container/message-persister'
import {
  findSessionAcrossAgents,
  getSession,
  updateSessionName,
  deleteSession,
} from '@/lib/services/session-service'

// GET /api/sessions/[id] - Get a single session
export async function GET(
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

    const { session } = result

    // Include whether the session is currently processing
    const isActive = messagePersister.isSessionActive(sessionId)

    return NextResponse.json({
      id: session.id,
      agentSlug: session.agentSlug,
      name: session.name,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      messageCount: session.messageCount,
      isActive,
    })
  } catch (error: unknown) {
    console.error('Failed to fetch session:', error)
    return NextResponse.json(
      { error: 'Failed to fetch session' },
      { status: 500 }
    )
  }
}

// PATCH /api/sessions/[id] - Update a session (e.g., rename)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: sessionId } = await params
    const body = await request.json()
    const { name } = body

    // Find which agent this session belongs to
    const result = await findSessionAcrossAgents(sessionId)

    if (!result) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    const { agentSlug, session } = result

    if (name?.trim()) {
      await updateSessionName(agentSlug, sessionId, name.trim())
    }

    // Fetch updated session
    const updated = await getSession(agentSlug, sessionId)

    return NextResponse.json({
      id: updated?.id || sessionId,
      agentSlug: updated?.agentSlug || agentSlug,
      name: updated?.name || name?.trim() || session.name,
      createdAt: updated?.createdAt || session.createdAt,
      lastActivityAt: updated?.lastActivityAt || session.lastActivityAt,
      messageCount: updated?.messageCount || session.messageCount,
    })
  } catch (error: unknown) {
    console.error('Failed to update session:', error)
    return NextResponse.json(
      { error: 'Failed to update session' },
      { status: 500 }
    )
  }
}

// DELETE /api/sessions/[id] - Delete a session
export async function DELETE(
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

    // Unsubscribe from message stream
    messagePersister.unsubscribeFromSession(sessionId)

    // Delete session files
    await deleteSession(agentSlug, sessionId)

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    console.error('Failed to delete session:', error)
    return NextResponse.json(
      { error: 'Failed to delete session' },
      { status: 500 }
    )
  }
}
