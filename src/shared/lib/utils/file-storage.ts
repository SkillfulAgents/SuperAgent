/**
 * File Storage Utilities
 *
 * Utilities for file-based agent storage including:
 * - Slug generation
 * - Markdown frontmatter parsing
 * - JSONL operations
 * - Directory operations
 * - Agent path helpers
 */

import * as fs from 'fs'
import * as path from 'path'
import { getDataDir } from '@shared/lib/config/data-dir'

// ============================================================================
// Slug Generation
// ============================================================================

/**
 * Generate a random alphanumeric string of specified length
 */
function generateRandomSuffix(length: number = 6): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

/**
 * Convert a name to a URL-safe slug
 * "My Cool Agent" -> "my-cool-agent"
 */
function nameToSlugBase(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
    .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
    .substring(0, 50) // Limit length
}

/**
 * Generate a URL-safe slug with unique suffix
 * "My Cool Agent" -> "my-cool-agent-k7x9m2"
 *
 * Note: Display name always comes from CLAUDE.md frontmatter, not the slug.
 * The slug is only used for directory names and URLs.
 */
export function generateAgentSlug(name: string): string {
  const base = nameToSlugBase(name)
  const suffix = generateRandomSuffix()
  return base ? `${base}-${suffix}` : suffix
}

/**
 * Generate a unique agent slug, checking for collisions
 * Regenerates random suffix if directory already exists
 */
export async function generateUniqueAgentSlug(name: string): Promise<string> {
  const maxAttempts = 10
  for (let i = 0; i < maxAttempts; i++) {
    const slug = generateAgentSlug(name)
    const agentDir = getAgentDir(slug)
    if (!await directoryExists(agentDir)) {
      return slug
    }
  }
  // Fallback: use timestamp for uniqueness
  const base = nameToSlugBase(name)
  const timestamp = Date.now().toString(36)
  return base ? `${base}-${timestamp}` : timestamp
}

// ============================================================================
// Frontmatter Parsing
// ============================================================================

export interface ParsedMarkdown<T = Record<string, unknown>> {
  frontmatter: T
  body: string
}

/**
 * Parse markdown file with YAML frontmatter
 * Returns { frontmatter: {...}, body: "..." }
 *
 * Frontmatter format:
 * ---
 * key: value
 * another: value
 * ---
 * Body content here
 */
export function parseMarkdownWithFrontmatter<T = Record<string, unknown>>(
  content: string
): ParsedMarkdown<T> {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
  const match = content.match(frontmatterRegex)

  if (!match) {
    // No frontmatter found, entire content is body
    return {
      frontmatter: {} as T,
      body: content,
    }
  }

  const [, frontmatterStr, body] = match
  const frontmatter: Record<string, unknown> = {}

  // Simple YAML parser for flat key-value pairs
  const lines = frontmatterStr.split(/\r?\n/)
  for (const line of lines) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue

    const key = line.substring(0, colonIndex).trim()
    let value: string | boolean | number = line.substring(colonIndex + 1).trim()

    // Remove surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    // Parse booleans and numbers
    if (value === 'true') value = true
    else if (value === 'false') value = false
    else if (!isNaN(Number(value)) && value !== '') value = Number(value)

    frontmatter[key] = value
  }

  return {
    frontmatter: frontmatter as T,
    body: body.trim(),
  }
}

/**
 * Serialize frontmatter + body back to markdown string
 */
export function serializeMarkdownWithFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string
): string {
  const lines: string[] = ['---']

  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue

    let serialized: string
    if (typeof value === 'string') {
      // Quote strings that contain special characters
      if (value.includes(':') || value.includes('#') || value.includes('\n')) {
        serialized = `"${value.replace(/"/g, '\\"')}"`
      } else {
        serialized = value
      }
    } else {
      serialized = String(value)
    }

    lines.push(`${key}: ${serialized}`)
  }

  lines.push('---')
  lines.push('')
  lines.push(body)

  return lines.join('\n')
}

// ============================================================================
// Directory Operations
// ============================================================================

/**
 * List subdirectories in a path (for listing agents)
 */
export async function listDirectories(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

/**
 * Check if directory exists
 */
export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(dirPath)
    return stat.isDirectory()
  } catch {
    return false
  }
}

/**
 * Check if file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath)
    return stat.isFile()
  } catch {
    return false
  }
}

/**
 * Safely remove directory recursively
 */
export async function removeDirectory(dirPath: string): Promise<void> {
  await fs.promises.rm(dirPath, { recursive: true, force: true })
}

/**
 * Create directory if it doesn't exist
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true })
}

/**
 * Read file contents, returns null if file doesn't exist
 */
export async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8')
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/**
 * Write file with optional mode (for secrets)
 */
export async function writeFile(
  filePath: string,
  content: string,
  options?: { mode?: number }
): Promise<void> {
  await fs.promises.writeFile(filePath, content, {
    encoding: 'utf-8',
    mode: options?.mode,
  })
}

// ============================================================================
// JSONL Operations
// ============================================================================

/**
 * Parse JSONL content into array of objects
 * Skips empty lines and handles parse errors gracefully
 */
export function parseJsonl<T = unknown>(content: string): T[] {
  const lines = content.split(/\r?\n/)
  const results: T[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    try {
      results.push(JSON.parse(trimmed) as T)
    } catch (error) {
      console.warn('Failed to parse JSONL line:', error)
      // Skip malformed lines
    }
  }

  return results
}

/**
 * Read and parse a JSONL file
 * Returns empty array if file doesn't exist
 */
export async function readJsonlFile<T = unknown>(filePath: string): Promise<T[]> {
  const content = await readFileOrNull(filePath)
  if (content === null) {
    return []
  }
  return parseJsonl<T>(content)
}

/**
 * Stream-read JSONL file line by line (for large files)
 * Yields parsed objects one at a time
 */
export async function* streamJsonlFile<T = unknown>(
  filePath: string
): AsyncIterable<T> {
  const fileHandle = await fs.promises.open(filePath, 'r')
  const stream = fileHandle.createReadStream({ encoding: 'utf-8' })

  let buffer = ''

  for await (const chunk of stream) {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)

    // Keep the last potentially incomplete line in buffer
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        yield JSON.parse(trimmed) as T
      } catch {
        // Skip malformed lines
      }
    }
  }

  // Process any remaining content in buffer
  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer.trim()) as T
    } catch {
      // Skip malformed line
    }
  }

  await fileHandle.close()
}

// ============================================================================
// Agent Path Helpers
// ============================================================================

/**
 * Get the agents root directory
 * ~/.superagent/agents/
 */
export function getAgentsDir(): string {
  return path.join(getDataDir(), 'agents')
}

/**
 * Get agent root directory
 * ~/.superagent/agents/{slug}/
 */
export function getAgentDir(slug: string): string {
  return path.join(getAgentsDir(), slug)
}

/**
 * Get agent workspace directory (mounted to container at /workspace)
 * ~/.superagent/agents/{slug}/workspace/
 */
export function getAgentWorkspaceDir(slug: string): string {
  return path.join(getAgentDir(slug), 'workspace')
}

/**
 * Get CLAUDE.md path for agent (inside workspace)
 * ~/.superagent/agents/{slug}/workspace/CLAUDE.md
 */
export function getAgentClaudeMdPath(slug: string): string {
  return path.join(getAgentWorkspaceDir(slug), 'CLAUDE.md')
}

/**
 * Get .env path for agent secrets
 * ~/.superagent/agents/{slug}/workspace/.env
 */
export function getAgentEnvPath(slug: string): string {
  return path.join(getAgentWorkspaceDir(slug), '.env')
}

/**
 * Get session metadata path
 * ~/.superagent/agents/{slug}/workspace/session-metadata.json
 */
export function getAgentSessionMetadataPath(slug: string): string {
  return path.join(getAgentWorkspaceDir(slug), 'session-metadata.json')
}

/**
 * Get Claude config directory (for CLAUDE_CONFIG_DIR env var)
 * ~/.superagent/agents/{slug}/workspace/.claude/
 */
export function getAgentClaudeConfigDir(slug: string): string {
  return path.join(getAgentWorkspaceDir(slug), '.claude')
}

/**
 * Get sessions directory where JSONL files are stored
 * ~/.superagent/agents/{slug}/workspace/.claude/projects/-workspace/
 */
export function getAgentSessionsDir(slug: string): string {
  return path.join(getAgentClaudeConfigDir(slug), 'projects', '-workspace')
}

/**
 * Get path to a specific session's JSONL file
 * ~/.superagent/agents/{slug}/workspace/.claude/projects/-workspace/{sessionId}.jsonl
 */
export function getSessionJsonlPath(slug: string, sessionId: string): string {
  return path.join(getAgentSessionsDir(slug), `${sessionId}.jsonl`)
}
