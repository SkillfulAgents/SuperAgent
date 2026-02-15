
import { ExternalLink } from 'lucide-react'
import type { ToolRenderer } from './types'

interface WebFetchInput {
  url?: string
}

function parseWebFetchInput(input: unknown): WebFetchInput {
  if (typeof input === 'object' && input !== null) {
    return input as WebFetchInput
  }
  return {}
}

function getSummary(input: unknown): string | null {
  const { url } = parseWebFetchInput(input)
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname : '')
  } catch {
    return url.length > 60 ? url.slice(0, 57) + '...' : url
  }
}

export const webFetchRenderer: ToolRenderer = {
  displayName: 'Web Fetch',
  icon: ExternalLink,
  getSummary,
}
