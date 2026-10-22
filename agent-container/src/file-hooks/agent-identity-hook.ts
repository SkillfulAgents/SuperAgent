import * as fs from 'fs'
import { FileHook, type FileHookChangeResult } from './file-hook'
import { notifyAgentIdentityChanged } from '../host-events'

const INSTRUCTIONS_PATH = '/workspace/AGENTS.md'
// A legacy CLAUDE.md is the instructions file in effect while it exists.
const LEGACY_INSTRUCTIONS_PATH = '/workspace/CLAUDE.md'

// Keep in sync with src/shared/lib/services/agent-identity-schema.ts
const NAME_MAX_LENGTH = 80
const DESCRIPTION_MAX_LENGTH = 200
// Keep in sync with UNTITLED_AGENT_NAME in src/renderer/hooks/use-create-untitled-agent.ts
const PLACEHOLDER_NAME = 'Untitled'

type IdentityField = 'name' | 'description'
type Identity = Partial<Record<IdentityField, string>>

/**
 * The name and description in a document's frontmatter, read the way the host
 * reads them: one `key: value` per line, surrounding quotes dropped.
 */
export function identityOf(content: string | null): Identity {
  const frontmatter = content?.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
  if (frontmatter === undefined) return {}
  const identity: Identity = {}
  for (const line of frontmatter.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.substring(0, colon).trim()
    if (key !== 'name' && key !== 'description') continue
    let value = line.substring(colon + 1).trim()
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1).trim()
    if (value) identity[key] = value
    else delete identity[key]
  }
  return identity
}

/** Why the host will not take this value, or null when it will. */
function rejection(field: IdentityField, value: string): string | null {
  if (/^[>|][+-]?$/.test(value)) return `it reads "${field}" from a single line, so a YAML block value is not read`
  const max = field === 'name' ? NAME_MAX_LENGTH : DESCRIPTION_MAX_LENGTH
  if (value.length > max) return `"${field}" is ${value.length} characters and it takes at most ${max}`
  return null
}

/**
 * The agent's name and description live in its instructions file's
 * frontmatter. When a Write or Edit changes either, tell the host, which
 * reads the file and updates the agent. When the file has no description,
 * or the name is still the placeholder, say so.
 */
export class AgentIdentityFileHook extends FileHook {
  pattern(): string {
    return `${INSTRUCTIONS_PATH}, ${LEGACY_INSTRUCTIONS_PATH}`
  }

  matches(filePath: string): boolean {
    return filePath === INSTRUCTIONS_PATH || filePath === LEGACY_INSTRUCTIONS_PATH
  }

  onChange(filePath: string, before: string | null, after: string): FileHookChangeResult {
    if (filePath === INSTRUCTIONS_PATH && fs.existsSync(LEGACY_INSTRUCTIONS_PATH)) return {}

    const previous = identityOf(before)
    const next = identityOf(after)
    const notes: string[] = []
    let changed = false
    for (const field of ['name', 'description'] as const) {
      const value = next[field]
      if (value === undefined || value === previous[field]) continue
      const reason = rejection(field, value)
      if (reason) notes.push(`The app keeps the agent's current ${field}: ${reason}.`)
      else changed = true
    }
    if (changed) {
      void notifyAgentIdentityChanged().catch((error) => {
        console.warn('[AgentIdentityFileHook] Failed to publish identity change:', error)
      })
    }

    if (next.description === undefined) {
      notes.push(`The frontmatter of ${filePath} has no "description" field. It is one sentence on what this agent is for; other agents and the todo picker read it.`)
    }
    if (next.name === PLACEHOLDER_NAME) {
      notes.push(`The "name" field is still the placeholder "${PLACEHOLDER_NAME}".`)
    }
    return notes.length > 0 ? { warning: notes.join(' ') } : {}
  }
}
