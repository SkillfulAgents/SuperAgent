import { NextRequest, NextResponse } from 'next/server'
import { containerManager } from '@/lib/container/container-manager'
import { messagePersister } from '@/lib/container/message-persister'
import { getSessionMessages } from '@/lib/services/session-service'
import { getAgent, agentExists } from '@/lib/services/agent-service'
import { transformMessages } from '@/lib/utils/message-transform'

// GET /api/agents/[id]/sessions/[sessionId]/messages - Get messages for a session
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; sessionId: string }> }
) {
  try {
    const { id: agentSlug, sessionId } = await params

    // Verify agent exists
    if (!(await agentExists(agentSlug))) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // Get messages from JSONL file
    // Note: Returns empty array if file doesn't exist yet (new session)
    const messages = await getSessionMessages(agentSlug, sessionId)

    // Filter out meta messages and transform to API format
    const filtered = messages.filter((m) => !('isMeta' in m && m.isMeta))
    const transformed = transformMessages(filtered)

    return NextResponse.json(transformed)
  } catch (error: unknown) {
    console.error('Failed to fetch messages:', error)
    return NextResponse.json(
      { error: 'Failed to fetch messages' },
      { status: 500 }
    )
  }
}

// POST /api/agents/[id]/sessions/[sessionId]/messages - Send a message
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; sessionId: string }> }
) {
  try {
    const { id: agentSlug, sessionId } = await params
    const body = await request.json()
    const { content } = body

    if (!content?.trim()) {
      return NextResponse.json({ error: 'Content is required' }, { status: 400 })
    }

    // Get agent
    const agent = await getAgent(agentSlug)
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // Get container client
    const client = containerManager.getClient(agentSlug)

    // Check if container is running, auto-start if not
    let info = await client.getInfo()
    if (info.status !== 'running') {
      await containerManager.ensureRunning(agentSlug)
      info = await client.getInfo()
    }

    // Subscribe to messages if not already subscribed
    if (!messagePersister.isSubscribed(sessionId)) {
      messagePersister.subscribeToSession(sessionId, client, sessionId, agentSlug)
    }

    // Mark session as active before sending
    messagePersister.markSessionActive(sessionId, agentSlug)

    // Send message to container (Claude SDK handles persistence to JSONL)
    await client.sendMessage(sessionId, content.trim())

    return NextResponse.json({ success: true }, { status: 201 })
  } catch (error: unknown) {
    console.error('Failed to send message:', error)
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    )
  }
}
