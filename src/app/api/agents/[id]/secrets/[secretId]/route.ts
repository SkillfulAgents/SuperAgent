import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agents, agentSecrets } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { keyToEnvVar } from '@/lib/utils/secrets'

// PUT /api/agents/[id]/secrets/[secretId] - Update a secret
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; secretId: string }> }
) {
  try {
    const { id, secretId } = await params
    const body = await request.json()
    const { key, value } = body

    // Verify agent exists
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1)

    if (agent.length === 0) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // Verify secret exists and belongs to this agent
    const secret = await db
      .select()
      .from(agentSecrets)
      .where(and(eq(agentSecrets.id, secretId), eq(agentSecrets.agentId, id)))
      .limit(1)

    if (secret.length === 0) {
      return NextResponse.json({ error: 'Secret not found' }, { status: 404 })
    }

    const updates: Partial<{
      key: string
      envVar: string
      value: string
      updatedAt: Date
    }> = {
      updatedAt: new Date(),
    }

    if (key?.trim()) {
      const newEnvVar = keyToEnvVar(key.trim())

      // Check if new envVar conflicts with another secret
      if (newEnvVar !== secret[0].envVar) {
        const existing = await db
          .select()
          .from(agentSecrets)
          .where(
            and(eq(agentSecrets.agentId, id), eq(agentSecrets.envVar, newEnvVar))
          )
          .limit(1)

        if (existing.length > 0) {
          return NextResponse.json(
            { error: `A secret with env var name "${newEnvVar}" already exists` },
            { status: 409 }
          )
        }
      }

      updates.key = key.trim()
      updates.envVar = newEnvVar
    }

    if (value !== undefined) {
      updates.value = value
    }

    await db
      .update(agentSecrets)
      .set(updates)
      .where(eq(agentSecrets.id, secretId))

    const updated = await db
      .select({
        id: agentSecrets.id,
        key: agentSecrets.key,
        envVar: agentSecrets.envVar,
        createdAt: agentSecrets.createdAt,
        updatedAt: agentSecrets.updatedAt,
      })
      .from(agentSecrets)
      .where(eq(agentSecrets.id, secretId))
      .limit(1)

    return NextResponse.json(updated[0])
  } catch (error: any) {
    console.error('Failed to update secret:', error)
    return NextResponse.json(
      { error: 'Failed to update secret' },
      { status: 500 }
    )
  }
}

// DELETE /api/agents/[id]/secrets/[secretId] - Delete a secret
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; secretId: string }> }
) {
  try {
    const { id, secretId } = await params

    // Verify agent exists
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1)

    if (agent.length === 0) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // Verify secret exists and belongs to this agent
    const secret = await db
      .select()
      .from(agentSecrets)
      .where(and(eq(agentSecrets.id, secretId), eq(agentSecrets.agentId, id)))
      .limit(1)

    if (secret.length === 0) {
      return NextResponse.json({ error: 'Secret not found' }, { status: 404 })
    }

    await db.delete(agentSecrets).where(eq(agentSecrets.id, secretId))

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Failed to delete secret:', error)
    return NextResponse.json(
      { error: 'Failed to delete secret' },
      { status: 500 }
    )
  }
}
