import { NextRequest, NextResponse } from 'next/server'
import { getOrCreateAuthConfig, initiateConnection } from '@/lib/composio/client'
import { isProviderSupported } from '@/lib/composio/providers'

// POST /api/connected-accounts/initiate - Start OAuth flow
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { providerSlug } = body

    if (!providerSlug) {
      return NextResponse.json(
        { error: 'Missing required field: providerSlug' },
        { status: 400 }
      )
    }

    // Check if provider is supported
    if (!isProviderSupported(providerSlug)) {
      return NextResponse.json(
        { error: `Provider '${providerSlug}' is not supported` },
        { status: 400 }
      )
    }

    // Get or create auth config for this provider
    const authConfig = await getOrCreateAuthConfig(providerSlug)

    // Build the callback URL with provider slug
    const origin = request.headers.get('origin') || request.nextUrl.origin
    const callbackUrl = `${origin}/api/connected-accounts/callback?toolkit=${encodeURIComponent(providerSlug)}`

    // Initiate the OAuth connection
    const { connectionId, redirectUrl } = await initiateConnection(
      authConfig.id,
      callbackUrl
    )

    return NextResponse.json({
      connectionId,
      redirectUrl,
      providerSlug,
    })
  } catch (error: any) {
    console.error('Failed to initiate connection:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to initiate connection' },
      { status: error.statusCode || 500 }
    )
  }
}
