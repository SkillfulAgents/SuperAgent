import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agents, agentSecrets } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { keyToEnvVar } from '@/lib/utils/secrets'

// GET /api/agents/[id]/secrets - List secrets for an agent
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

    const secrets = await db
      .select({
        id: agentSecrets.id,
        key: agentSecrets.key,
        envVar: agentSecrets.envVar,
        // Don't return the actual value for security - return masked version
        createdAt: agentSecrets.createdAt,
        updatedAt: agentSecrets.updatedAt,
      })
      .from(agentSecrets)
      .where(eq(agentSecrets.agentId, id))

    return NextResponse.json(secrets)
  } catch (error: any) {
    console.error('Failed to fetch secrets:', error)
    return NextResponse.json(
      { error: 'Failed to fetch secrets' },
      { status: 500 }
    )
  }
}

// POST /api/agents/[id]/secrets - Create a new secret
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()
    const { key, value } = body

    if (!key?.trim()) {
      return NextResponse.json({ error: 'Key is required' }, { status: 400 })
    }

    if (!value) {
      return NextResponse.json({ error: 'Value is required' }, { status: 400 })
    }

    // Verify agent exists
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1)

    if (agent.length === 0) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const envVar = keyToEnvVar(key.trim())

    // Check if envVar already exists for this agent
    const existing = await db
      .select()
      .from(agentSecrets)
      .where(and(eq(agentSecrets.agentId, id), eq(agentSecrets.envVar, envVar)))
      .limit(1)

    if (existing.length > 0) {
      return NextResponse.json(
        { error: `A secret with env var name "${envVar}" already exists` },
        { status: 409 }
      )
    }

    const now = new Date()
    const secret = {
      id: uuidv4(),
      agentId: id,
      key: key.trim(),
      envVar,
      value,
      createdAt: now,
      updatedAt: now,
    }

    await db.insert(agentSecrets).values(secret)

    // Return without the actual value
    return NextResponse.json(
      {
        id: secret.id,
        key: secret.key,
        envVar: secret.envVar,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
      },
      { status: 201 }
    )
  } catch (error: any) {
    console.error('Failed to create secret:', error)
    return NextResponse.json(
      { error: 'Failed to create secret' },
      { status: 500 }
    )
  }
}
