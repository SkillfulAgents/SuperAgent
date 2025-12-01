import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sessions } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { messagePersister } from '@/lib/container/message-persister'

// GET /api/sessions/[id] - Get a single session
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const session = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1)

    if (session.length === 0) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    // Include whether the session is currently processing
    const isActive = messagePersister.isSessionActive(id)

    return NextResponse.json({
      ...session[0],
      isActive,
    })
  } catch (error: any) {
    console.error('Failed to fetch session:', error)
    return NextResponse.json(
      { error: 'Failed to fetch session' },
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
    const { id } = await params

    const session = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1)

    if (session.length === 0) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    // Unsubscribe from message stream
    messagePersister.unsubscribeFromSession(id)

    // Delete from database (messages will cascade)
    await db.delete(sessions).where(eq(sessions.id, id))

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Failed to delete session:', error)
    return NextResponse.json(
      { error: 'Failed to delete session' },
      { status: 500 }
    )
  }
}
