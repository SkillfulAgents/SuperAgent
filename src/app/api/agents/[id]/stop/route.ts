import { NextRequest, NextResponse } from 'next/server'
import { containerManager } from '@/lib/container/container-manager'
import { getAgent, agentExists } from '@/lib/services/agent-service'

// POST /api/agents/[id]/stop - Stop an agent's container
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: slug } = await params

    // Verify agent exists
    const agent = await getAgent(slug)
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // Get container client
    const client = containerManager.getClient(slug)

    // Check if already stopped via Docker
    const info = await client.getInfo()
    if (info.status === 'stopped') {
      return NextResponse.json({
        slug: agent.slug,
        name: agent.frontmatter.name,
        description: agent.frontmatter.description,
        createdAt: agent.frontmatter.createdAt,
        status: 'stopped',
        containerPort: null,
        message: 'Agent is already stopped',
      })
    }

    // Stop the container
    await client.stop()

    return NextResponse.json({
      slug: agent.slug,
      name: agent.frontmatter.name,
      description: agent.frontmatter.description,
      createdAt: agent.frontmatter.createdAt,
      status: 'stopped',
      containerPort: null,
    })
  } catch (error: unknown) {
    console.error('Failed to stop agent:', error)
    return NextResponse.json(
      { error: 'Failed to stop agent' },
      { status: 500 }
    )
  }
}
