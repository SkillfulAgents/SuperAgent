import { NextRequest, NextResponse } from 'next/server'
import { containerManager } from '@/lib/container/container-manager'
import { messagePersister } from '@/lib/container/message-persister'
import { getAgent, agentExists } from '@/lib/services/agent-service'
import { listSessions, updateSessionName, registerSession } from '@/lib/services/session-service'
import { getSecretEnvVars } from '@/lib/services/secrets-service'
import { withRetry } from '@/lib/utils/retry'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic()

// Model used for generating session names (lightweight task)
const SUMMARIZER_MODEL = process.env.SUMMARIZER_MODEL || 'claude-haiku-4-5'

// GET /api/agents/[id]/sessions - List sessions for an agent
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: slug } = await params

    // Verify agent exists
    if (!(await agentExists(slug))) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const sessions = await listSessions(slug)

    // Include isActive status for each session
    const sessionsWithStatus = sessions.map((session) => ({
      ...session,
      isActive: messagePersister.isSessionActive(session.id),
    }))

    return NextResponse.json(sessionsWithStatus)
  } catch (error: unknown) {
    console.error('Failed to fetch sessions:', error)
    return NextResponse.json(
      { error: 'Failed to fetch sessions' },
      { status: 500 }
    )
  }
}

// Generate session name using AI (fire and forget)
async function generateAndUpdateSessionNameAsync(
  agentSlug: string,
  sessionId: string,
  message: string,
  agentName: string
): Promise<void> {
  try {
    const response = await withRetry(() =>
      anthropic.messages.create({
        model: SUMMARIZER_MODEL,
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
    )

    const textBlock = response.content.find((block) => block.type === 'text')
    const sessionName = textBlock?.type === 'text' ? textBlock.text.trim() : null

    if (sessionName) {
      // Update session name in session-metadata.json
      await updateSessionName(agentSlug, sessionId, sessionName)

      // Notify connected clients that session metadata has changed
      messagePersister.broadcastSessionUpdate(sessionId)
    }
  } catch (error) {
    console.error('Failed to generate session name after retries:', error)
    // Non-critical error, session will keep its default name
  }
}

// POST /api/agents/[id]/sessions - Create a new session with initial message
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: slug } = await params
    const body = await request.json()
    const { message } = body

    if (!message?.trim()) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 })
    }

    // Get agent
    const agent = await getAgent(slug)
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // Ensure container is running
    const client = await containerManager.ensureRunning(slug)

    // Get secret env var names to pass to the agent
    const availableEnvVars = await getSecretEnvVars(slug)

    // Create container session with initial message
    // Note: System prompt now comes from CLAUDE.md via settingSources: ['project']
    // We only pass availableEnvVars so the agent knows what secrets are available
    // The session creation is atomic - it sends the first message and waits for Claude's session ID
    const containerSession = await client.createSession({
      availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
      initialMessage: message.trim(),
    })
    const sessionId = containerSession.id

    // Register session immediately so it appears in listings
    // The sessionId is now Claude's canonical session ID (matches JSONL filename)
    await registerSession(slug, sessionId, 'New Session')

    // Subscribe to messages for this session (for SSE broadcasting)
    messagePersister.subscribeToSession(sessionId, client, sessionId, slug)

    // Mark session as active since we just sent the initial message
    messagePersister.markSessionActive(sessionId, slug)

    // Generate session name in background (fire and forget)
    generateAndUpdateSessionNameAsync(
      slug,
      sessionId,
      message.trim(),
      agent.frontmatter.name
    ).catch(console.error)

    // Return session info
    // Note: The JSONL file will be created by Claude SDK
    return NextResponse.json(
      {
        id: sessionId,
        agentSlug: slug,
        name: 'New Session',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        messageCount: 0,
        isActive: true,
      },
      { status: 201 }
    )
  } catch (error: unknown) {
    console.error('Failed to create session:', error)
    return NextResponse.json(
      { error: 'Failed to create session' },
      { status: 500 }
    )
  }
}
