import { agentRegistry, WorkspaceFileError, type FileEntry } from '@shared/lib/agent-actor'

export interface Skill {
  name: string
  description: string
  path: string
}

/** Workspace directory that holds one sub-directory per skill. */
const SKILLS_DIR = '.claude/skills'

const decoder = new TextDecoder()

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Returns the description field if found.
 */
function parseFrontmatter(content: string): { description?: string } {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) {
    return {}
  }

  const frontmatter = frontmatterMatch[1]
  const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m)

  return {
    description: descriptionMatch ? descriptionMatch[1].trim() : undefined,
  }
}

/**
 * Get the display name from a skill directory name.
 * Converts kebab-case to Title Case.
 */
function getDisplayName(dirName: string): string {
  return dirName
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Read all skills for an agent from their workspace.
 */
export async function getAgentSkills(agentId: string): Promise<Skill[]> {
  const { files } = agentRegistry.get(agentId)

  let entries: FileEntry[]
  try {
    entries = await files.list(SKILLS_DIR)
  } catch (error) {
    // No skills directory yet (or a file in its place) is simply no skills.
    if (error instanceof WorkspaceFileError && (error.code === 'not-found' || error.code === 'not-a-directory')) {
      return []
    }
    console.error(`Failed to read skills directory for agent ${agentId}:`, error)
    return []
  }

  const skills: Skill[] = []
  for (const entry of entries) {
    if (entry.kind !== 'directory') continue

    try {
      const bytes = await files.getDoc(`${SKILLS_DIR}/${entry.name}/SKILL.md`)
      // A skill directory without a SKILL.md is not a skill.
      if (bytes === null) continue

      const { description } = parseFrontmatter(decoder.decode(bytes))
      skills.push({
        name: getDisplayName(entry.name),
        description: description || 'No description provided',
        path: entry.name,
      })
    } catch (error) {
      console.error(`Failed to read skill ${entry.name}:`, error)
    }
  }

  // Sort alphabetically by name
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}
