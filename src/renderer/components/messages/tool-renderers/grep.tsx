
import { Search } from 'lucide-react'
import type { ToolRenderer } from './types'

interface GrepInput {
  pattern?: string
  path?: string
}

function parseGrepInput(input: unknown): GrepInput {
  if (typeof input === 'object' && input !== null) {
    return input as GrepInput
  }
  return {}
}

function getSummary(input: unknown): string | null {
  const { pattern, path } = parseGrepInput(input)
  if (!pattern) return null
  const parts = [`/${pattern}/`]
  if (path) parts.push(`in ${path}`)
  return parts.join(' ')
}

export const grepRenderer: ToolRenderer = {
  displayName: 'Grep',
  icon: Search,
  getSummary,
}
