import { NextRequest, NextResponse } from 'next/server'
import {
  getSecret,
  setSecret,
  deleteSecret,
  keyToEnvVar,
} from '@/lib/services/secrets-service'
import { agentExists } from '@/lib/services/agent-service'

// Note: secretId parameter is now the envVar name (e.g., "MY_API_KEY")

// PUT /api/agents/[id]/secrets/[secretId] - Update a secret
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; secretId: string }> }
) {
  try {
    const { id: slug, secretId: envVar } = await params
    const body = await request.json()
    const { key, value } = body

    // Verify agent exists
    if (!(await agentExists(slug))) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // Get existing secret
    const existing = await getSecret(slug, envVar)
    if (!existing) {
      return NextResponse.json({ error: 'Secret not found' }, { status: 404 })
    }

    // If key is being changed, we need to delete old and create new
    const newKey = key?.trim() || existing.key
    const newEnvVar = keyToEnvVar(newKey)
    const newValue = value !== undefined ? value : existing.value

    if (newEnvVar !== envVar) {
      // Key changed - delete old, create new
      await deleteSecret(slug, envVar)
    }

    await setSecret(slug, {
      key: newKey,
      envVar: newEnvVar,
      value: newValue,
    })

    return NextResponse.json({
      key: newKey,
      envVar: newEnvVar,
      hasValue: true,
    })
  } catch (error: unknown) {
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
    const { id: slug, secretId: envVar } = await params

    // Verify agent exists
    if (!(await agentExists(slug))) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const deleted = await deleteSecret(slug, envVar)

    if (!deleted) {
      return NextResponse.json({ error: 'Secret not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    console.error('Failed to delete secret:', error)
    return NextResponse.json(
      { error: 'Failed to delete secret' },
      { status: 500 }
    )
  }
}
