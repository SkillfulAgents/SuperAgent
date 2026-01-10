import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agents, sessions, messages, agentSecrets } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { containerManager } from '@/lib/container/container-manager'
import { messagePersister } from '@/lib/container/message-persister'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic()

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

// Generate session name using AI (fire and forget)
async function generateAndUpdateSessionName(
  sessionId: string,
  message: string,
  agentName: string
): Promise<void> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 50,
      messages: [
        {
          role: 'user',
          content: `Generate a short, descriptive session name (3-6 words max) for a conversation with an AI agent named "${agentName}". The first message in the conversation is:

"${message}"

Respond with ONLY the session name, nothing else. No quotes, no explanation.`,
        },
      ],
    })

    const textBlock = response.content.find((block) => block.type === 'text')
    const sessionName = textBlock?.type === 'text' ? textBlock.text.trim() : null

    if (sessionName) {
      await db
        .update(sessions)
        .set({ name: sessionName })
        .where(eq(sessions.id, sessionId))

      // Notify connected clients that session metadata has changed
      messagePersister.broadcastSessionUpdate(sessionId)
    }
  } catch (error) {
    console.error('Failed to generate session name:', error)
    // Non-critical error, session will keep its default name
  }
}

// POST /api/agents/[id]/sessions - Create a new session with initial message
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()
    const { message } = body

    if (!message?.trim()) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 })
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

    const agentData = agent[0]
    const sessionId = uuidv4()

    // Ensure container is running (fetches secrets and starts if needed)
    const client = await containerManager.ensureRunning(id)

    // Fetch secret env var names to pass to the agent
    const secrets = await db
      .select({ envVar: agentSecrets.envVar })
      .from(agentSecrets)
      .where(eq(agentSecrets.agentId, id))

    const availableEnvVars = secrets.map((s) => s.envVar)

    // Create container session with agent's system prompt and available env vars
    const containerSession = await client.createSession({
      systemPrompt: agentData.systemPrompt || undefined,
      availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
    })
    const containerSessionId = containerSession.id

    // Subscribe to messages for this session
    messagePersister.subscribeToSession(sessionId, client, containerSessionId)

    // Create session in database with temporary name
    const now = new Date()
    const newSession = {
      id: sessionId,
      agentId: id,
      name: 'New Session',
      containerSessionId,
      createdAt: now,
      lastActivityAt: now,
    }

    await db.insert(sessions).values(newSession)

    // Save user message to database and mark session as active
    await messagePersister.saveUserMessage(sessionId, message.trim())

    // Send message to container
    await client.sendMessage(containerSessionId, message.trim())

    // Generate session name in background (fire and forget)
    generateAndUpdateSessionName(sessionId, message.trim(), agentData.name).catch(
      console.error
    )

    return NextResponse.json(newSession, { status: 201 })
  } catch (error: any) {
    console.error('Failed to create session:', error)
    return NextResponse.json(
      { error: 'Failed to create session' },
      { status: 500 }
    )
  }
}
