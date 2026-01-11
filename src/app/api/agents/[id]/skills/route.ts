import { NextRequest, NextResponse } from 'next/server'
import { getAgentSkills } from '@/lib/skills'

// GET /api/agents/[id]/skills - Get skills for an agent
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const skills = await getAgentSkills(id)

    return NextResponse.json({ skills })
  } catch (error: any) {
    console.error('Failed to fetch skills:', error)
    return NextResponse.json(
      { error: 'Failed to fetch skills' },
      { status: 500 }
    )
  }
}
