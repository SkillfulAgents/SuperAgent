import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agents } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { containerManager } from '@/lib/container/container-manager'

// GET /api/agents/[id] - Get a single agent
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1)

    if (agent.length === 0) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // Query Docker for status
    const client = containerManager.getClient(id)
    const info = await client.getInfo()

    return NextResponse.json({
      ...agent[0],
      status: info.status,
      containerPort: info.port,
    })
  } catch (error: any) {
    console.error('Failed to fetch agent:', error)
    return NextResponse.json(
      { error: 'Failed to fetch agent' },
      { status: 500 }
    )
  }
}

// PUT /api/agents/[id] - Update an agent
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()
    const { name, systemPrompt } = body

    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1)

    if (agent.length === 0) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const updates: Partial<typeof agents.$inferInsert> = {
      updatedAt: new Date(),
    }

    if (name?.trim()) {
      updates.name = name.trim()
    }

    // Allow setting systemPrompt to null/empty to clear it
    if (systemPrompt !== undefined) {
      updates.systemPrompt = systemPrompt?.trim() || null
    }

    await db.update(agents).set(updates).where(eq(agents.id, id))

    const updated = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1)

    // Query Docker for status
    const client = containerManager.getClient(id)
    const info = await client.getInfo()

    return NextResponse.json({
      ...updated[0],
      status: info.status,
      containerPort: info.port,
    })
  } catch (error: any) {
    console.error('Failed to update agent:', error)
    return NextResponse.json(
      { error: 'Failed to update agent' },
      { status: 500 }
    )
  }
}

// DELETE /api/agents/[id] - Delete an agent
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1)

    if (agent.length === 0) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // Stop and remove the container if running
    const client = containerManager.getClient(id)
    await client.stop()
    containerManager.removeClient(id)

    // Delete from database (sessions and messages will cascade)
    await db.delete(agents).where(eq(agents.id, id))

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Failed to delete agent:', error)
    return NextResponse.json(
      { error: 'Failed to delete agent' },
      { status: 500 }
    )
  }
}
