import { NextRequest, NextResponse } from 'next/server'
import { containerManager } from '@/lib/container/container-manager'
import { findSessionAcrossAgents } from '@/lib/services/session-service'
import { setSecret } from '@/lib/services/secrets-service'

interface ProvideSecretRequest {
  toolUseId: string // Used for container resolution (keyed by toolUseId)
  secretName: string // The environment variable name for the secret
  value?: string
  decline?: boolean
  declineReason?: string
}

// POST /api/sessions/[id]/provide-secret - Provide or decline a secret request
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: sessionId } = await params
    const body: ProvideSecretRequest = await request.json()
    const { toolUseId, secretName, value, decline, declineReason } = body

    // Validate required fields
    if (!toolUseId) {
      return NextResponse.json(
        { error: 'toolUseId is required' },
        { status: 400 }
      )
    }

    if (!secretName) {
      return NextResponse.json(
        { error: 'secretName is required' },
        { status: 400 }
      )
    }

    // Find which agent this session belongs to
    const result = await findSessionAcrossAgents(sessionId)

    if (!result) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    const { agentSlug } = result

    // Get container client
    const client = containerManager.getClient(agentSlug)

    // Handle decline
    if (decline) {
      const reason = declineReason || 'User declined to provide the secret'

      const rejectResponse = await client.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      )

      if (!rejectResponse.ok) {
        const error = await rejectResponse.json()
        console.error('Failed to reject secret request:', error)
        return NextResponse.json(
          { error: 'Failed to reject secret request' },
          { status: 500 }
        )
      }

      return NextResponse.json({ success: true, declined: true })
    }

    // Handle provide - value is required
    if (!value) {
      return NextResponse.json(
        { error: 'value is required when not declining' },
        { status: 400 }
      )
    }

    // Save the secret to .env file
    await setSecret(agentSlug, {
      key: secretName, // Use secretName as both key and envVar
      envVar: secretName,
      value,
    })

    // Set environment variable in container FIRST (before resolving)
    // This ensures the env var is available when the tool returns
    console.log(`[provide-secret] Setting env var ${secretName} in container`)
    const envResponse = await client.fetch('/env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: secretName, value }),
    })

    if (!envResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await envResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await envResponse.text()
      }
      console.error(`[provide-secret] Failed to set env var: ${errorDetails}`)
      return NextResponse.json(
        { error: 'Failed to set environment variable in container' },
        { status: 500 }
      )
    }
    console.log(`[provide-secret] Env var ${secretName} set successfully`)

    // NOW resolve the pending input request (keyed by toolUseId in container)
    console.log(`[provide-secret] Resolving pending request ${toolUseId}`)
    const resolveResponse = await client.fetch(
      `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      }
    )

    if (!resolveResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await resolveResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await resolveResponse.text()
      }
      console.error(`[provide-secret] Failed to resolve request: ${errorDetails}`)
      return NextResponse.json(
        { error: 'Secret saved but failed to notify agent' },
        { status: 500 }
      )
    }
    console.log(`[provide-secret] Request ${toolUseId} resolved successfully`)

    return NextResponse.json({ success: true, saved: true })
  } catch (error: unknown) {
    console.error('Failed to provide secret:', error)
    return NextResponse.json(
      { error: 'Failed to provide secret' },
      { status: 500 }
    )
  }
}
