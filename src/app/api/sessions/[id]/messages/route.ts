import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sessions, messages, agents, toolCalls } from '@/lib/db/schema'
import { eq, asc, inArray } from 'drizzle-orm'
import { containerManager } from '@/lib/container/container-manager'
import { messagePersister } from '@/lib/container/message-persister'

// GET /api/sessions/[id]/messages - Get messages for a session
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // Verify session exists
    const session = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1)

    if (session.length === 0) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    // Fetch messages
    const sessionMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, id))
      .orderBy(asc(messages.createdAt))

    // Fetch tool calls for all messages
    const messageIds = sessionMessages.map((m) => m.id)
    const allToolCalls =
      messageIds.length > 0
        ? await db
            .select()
            .from(toolCalls)
            .where(inArray(toolCalls.messageId, messageIds))
        : []

    // Group tool calls by message ID
    const toolCallsByMessage = new Map<string, typeof allToolCalls>()
    for (const tc of allToolCalls) {
      const existing = toolCallsByMessage.get(tc.messageId) || []
      existing.push(tc)
      toolCallsByMessage.set(tc.messageId, existing)
    }

    // Combine messages with their tool calls
    const messagesWithToolCalls = sessionMessages.map((msg) => ({
      ...msg,
      toolCalls: toolCallsByMessage.get(msg.id) || [],
    }))

    return NextResponse.json(messagesWithToolCalls)
  } catch (error: any) {
    console.error('Failed to fetch messages:', error)
    return NextResponse.json(
      { error: 'Failed to fetch messages' },
      { status: 500 }
    )
  }
}

// POST /api/sessions/[id]/messages - Send a message
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()
    const { content } = body

    if (!content?.trim()) {
      return NextResponse.json({ error: 'Content is required' }, { status: 400 })
    }

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

    // Check if container is running via Docker, auto-start if not
    let info = await client.getInfo()
    if (info.status !== 'running') {
      await client.start()
      info = await client.getInfo()
    }

    // Create container session if needed
    let containerSessionId = sessionData.containerSessionId
    if (!containerSessionId) {
      const containerSession = await client.createSession()
      containerSessionId = containerSession.id

      // Update session with container session ID
      await db
        .update(sessions)
        .set({ containerSessionId })
        .where(eq(sessions.id, id))
    }

    // Subscribe to messages if not already subscribed
    // This handles both new sessions and resumed sessions after container restart
    if (!messagePersister.isSubscribed(id)) {
      messagePersister.subscribeToSession(id, client, containerSessionId)
    }

    // Save user message to database
    await messagePersister.saveUserMessage(id, content.trim())

    // Send message to container
    await client.sendMessage(containerSessionId, content.trim())

    return NextResponse.json({ success: true }, { status: 201 })
  } catch (error: any) {
    console.error('Failed to send message:', error)
    return NextResponse.json(
      { error: 'Failed to send message', details: error.message },
      { status: 500 }
    )
  }
}
