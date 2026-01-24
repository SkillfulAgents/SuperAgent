import { NextRequest, NextResponse } from 'next/server'
import { containerManager } from '@/lib/container/container-manager'
import { getAgentWithStatus, agentExists } from '@/lib/services/agent-service'

// POST /api/agents/[id]/start - Start an agent's container
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: slug } = await params

    // Verify agent exists
    if (!(await agentExists(slug))) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // Ensure container is running
    await containerManager.ensureRunning(slug)

    // Get agent with updated status
    const agent = await getAgentWithStatus(slug)

    return NextResponse.json(agent)
  } catch (error: unknown) {
    console.error('Failed to start agent:', error)
    return NextResponse.json(
      { error: 'Failed to start agent' },
      { status: 500 }
    )
  }
}
