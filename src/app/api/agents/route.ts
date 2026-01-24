import { NextRequest, NextResponse } from 'next/server'
import {
  listAgentsWithStatus,
  createAgent,
} from '@/lib/services/agent-service'

// GET /api/agents - List all agents with status from Docker
export async function GET() {
  try {
    const agents = await listAgentsWithStatus()
    return NextResponse.json(agents)
  } catch (error: unknown) {
    console.error('Failed to fetch agents:', error)
    return NextResponse.json(
      { error: 'Failed to fetch agents' },
      { status: 500 }
    )
  }
}

// POST /api/agents - Create a new agent
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { name, description } = body

    if (!name?.trim()) {
      return NextResponse.json(
        { error: 'Name is required' },
        { status: 400 }
      )
    }

    const agent = await createAgent({
      name: name.trim(),
      description: description?.trim(),
    })

    return NextResponse.json(agent, { status: 201 })
  } catch (error: unknown) {
    console.error('Failed to create agent:', error)
    return NextResponse.json(
      { error: 'Failed to create agent' },
      { status: 500 }
    )
  }
}
