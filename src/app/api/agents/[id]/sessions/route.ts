import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agents, sessions } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { containerManager } from '@/lib/container/container-manager'
import { messagePersister } from '@/lib/container/message-persister'

// GET /api/agents/[id]/sessions - List sessions for an agent
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // Verify agent exists
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1)

    if (agent.length === 0) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const agentSessions = await db
      .select()
      .from(sessions)
      .where(eq(sessions.agentId, id))
      .orderBy(desc(sessions.createdAt))

    // Include isActive status for each session
    const sessionsWithStatus = agentSessions.map((session) => ({
      ...session,
      isActive: messagePersister.isSessionActive(session.id),
    }))

    return NextResponse.json(sessionsWithStatus)
  } catch (error: any) {
    console.error('Failed to fetch sessions:', error)
    return NextResponse.json(
      { error: 'Failed to fetch sessions' },
      { status: 500 }
    )
  }
}

// POST /api/agents/[id]/sessions - Create a new session
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()
    const { name } = body

    if (!name?.trim()) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    // Get agent
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1)

    if (agent.length === 0) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const sessionId = uuidv4()
    let containerSessionId: string | null = null

    // Check if agent is running via Docker
    const client = containerManager.getClient(id)
    const info = await client.getInfo()

    if (info.status === 'running') {
      const containerSession = await client.createSession()
      containerSessionId = containerSession.id

      // Subscribe to messages for this session
      messagePersister.subscribeToSession(sessionId, client, containerSessionId)
    }

    const now = new Date()
    const newSession = {
      id: sessionId,
      agentId: id,
      name: name.trim(),
      containerSessionId,
      createdAt: now,
      lastActivityAt: now,
    }

    await db.insert(sessions).values(newSession)

    return NextResponse.json(newSession, { status: 201 })
  } catch (error: any) {
    console.error('Failed to create session:', error)
    return NextResponse.json(
      { error: 'Failed to create session' },
      { status: 500 }
    )
  }
}
