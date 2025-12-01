import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { agents } from '@/lib/db/schema'
import { v4 as uuidv4 } from 'uuid'
import { desc } from 'drizzle-orm'
import { containerManager } from '@/lib/container/container-manager'

// GET /api/agents - List all agents with status from Docker
export async function GET() {
  try {
    const allAgents = await db
      .select()
      .from(agents)
      .orderBy(desc(agents.createdAt))

    // Get status for each agent from Docker
    const agentsWithStatus = await Promise.all(
      allAgents.map(async (agent) => {
        const client = containerManager.getClient(agent.id)
        const info = await client.getInfo()
        return {
          ...agent,
          status: info.status,
          containerPort: info.port,
        }
      })
    )

    return NextResponse.json(agentsWithStatus)
  } catch (error: any) {
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
    const { name } = body

    if (!name?.trim()) {
      return NextResponse.json(
        { error: 'Name is required' },
        { status: 400 }
      )
    }

    const now = new Date()
    const newAgent = {
      id: uuidv4(),
      name: name.trim(),
      createdAt: now,
      updatedAt: now,
    }

    await db.insert(agents).values(newAgent)

    // Return with status from Docker (will be 'stopped' for new agent)
    return NextResponse.json(
      { ...newAgent, status: 'stopped', containerPort: null },
      { status: 201 }
    )
  } catch (error: any) {
    console.error('Failed to create agent:', error)
    return NextResponse.json(
      { error: 'Failed to create agent' },
      { status: 500 }
    )
  }
}
