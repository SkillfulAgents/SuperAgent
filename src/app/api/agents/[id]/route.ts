import { NextRequest, NextResponse } from 'next/server'
import {
  getAgentWithStatus,
  updateAgent,
  deleteAgent,
} from '@/lib/services/agent-service'
import { containerManager } from '@/lib/container/container-manager'

// Note: Route param is still called 'id' but is now the agent slug

// GET /api/agents/[id] - Get a single agent
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: slug } = await params
    const agent = await getAgentWithStatus(slug)

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    return NextResponse.json(agent)
  } catch (error: unknown) {
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
    const { id: slug } = await params
    const body = await request.json()
    const { name, description, instructions } = body

    const agent = await updateAgent(slug, {
      name: name?.trim(),
      description: description?.trim(),
      instructions: instructions,
    })

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    return NextResponse.json(agent)
  } catch (error: unknown) {
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
    const { id: slug } = await params

    // deleteAgent handles stopping container and removing directory
    const deleted = await deleteAgent(slug)

    if (!deleted) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // Remove from container manager cache
    containerManager.removeClient(slug)

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    console.error('Failed to delete agent:', error)
    return NextResponse.json(
      { error: 'Failed to delete agent' },
      { status: 500 }
    )
  }
}
