import fs from 'fs'
import path from 'path'
import { getAgentWorkspaceDir } from '@/lib/config/data-dir'

export interface Skill {
  name: string
  description: string
  path: string
}

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
 * Read all skills for an agent from their workspace directory.
 */
export async function getAgentSkills(agentId: string): Promise<Skill[]> {
  const workspaceDir = getAgentWorkspaceDir(agentId)
  const skillsDir = path.join(workspaceDir, '.claude', 'skills')

  // Check if skills directory exists
  if (!fs.existsSync(skillsDir)) {
    return []
  }

  const skills: Skill[] = []

  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillPath = path.join(skillsDir, entry.name)
      const skillMdPath = path.join(skillPath, 'SKILL.md')

      // Check if SKILL.md exists
      if (!fs.existsSync(skillMdPath)) continue

      try {
        const content = fs.readFileSync(skillMdPath, 'utf-8')
        const { description } = parseFrontmatter(content)

        skills.push({
          name: getDisplayName(entry.name),
          description: description || 'No description provided',
          path: entry.name,
        })
      } catch (error) {
        console.error(`Failed to read skill ${entry.name}:`, error)
      }
    }
  } catch (error) {
    console.error(`Failed to read skills directory for agent ${agentId}:`, error)
  }

  // Sort alphabetically by name
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}
