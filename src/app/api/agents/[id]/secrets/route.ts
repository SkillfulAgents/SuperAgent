import { NextRequest, NextResponse } from 'next/server'
import {
  listSecrets,
  getSecret,
  setSecret,
  keyToEnvVar,
} from '@/lib/services/secrets-service'
import { agentExists } from '@/lib/services/agent-service'

// GET /api/agents/[id]/secrets - List secrets for an agent
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

    const secrets = await listSecrets(slug)

    // Return without actual values for security
    const response = secrets.map((secret) => ({
      key: secret.key,
      envVar: secret.envVar,
      // Mask the value - just show that it exists
      hasValue: true,
    }))

    return NextResponse.json(response)
  } catch (error: unknown) {
    console.error('Failed to fetch secrets:', error)
    return NextResponse.json(
      { error: 'Failed to fetch secrets' },
      { status: 500 }
    )
  }
}

// POST /api/agents/[id]/secrets - Create or update a secret
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: slug } = await params
    const body = await request.json()
    const { key, value } = body

    if (!key?.trim()) {
      return NextResponse.json({ error: 'Key is required' }, { status: 400 })
    }

    if (value === undefined || value === null) {
      return NextResponse.json({ error: 'Value is required' }, { status: 400 })
    }

    // Verify agent exists
    if (!(await agentExists(slug))) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const envVar = keyToEnvVar(key.trim())

    // Set the secret (creates or updates)
    await setSecret(slug, {
      key: key.trim(),
      envVar,
      value,
    })

    return NextResponse.json(
      {
        key: key.trim(),
        envVar,
        hasValue: true,
      },
      { status: 201 }
    )
  } catch (error: unknown) {
    console.error('Failed to create secret:', error)
    return NextResponse.json(
      { error: 'Failed to create secret' },
      { status: 500 }
    )
  }
}
