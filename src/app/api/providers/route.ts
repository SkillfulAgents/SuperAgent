import { NextResponse } from 'next/server'
import { getAllProviders } from '@/lib/composio/providers'

// GET /api/providers - List all supported OAuth providers
export async function GET() {
  const providers = getAllProviders()
  return NextResponse.json({ providers })
}
