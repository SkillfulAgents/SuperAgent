/**
 * Skillset Types
 *
 * Type definitions for skillset integration - discovering, installing,
 * and managing skills from shared git repositories.
 */

// ============================================================================
// Skillset Index (from repository index.json)
// ============================================================================

/** A single skill entry within a skillset's index.json */
export interface SkillsetIndexSkill {
  name: string
  path: string // e.g., "skills/supabase-query/SKILL.md"
  description: string
  version: string
}

/** The index.json structure of a skillset repository */
export interface SkillsetIndex {
  skillset_name: string
  description: string
  version: string
  skills: SkillsetIndexSkill[]
  agents?: SkillsetIndexAgent[]
}

// ============================================================================
// Skillset Configuration (stored in settings)
// ============================================================================

/** A configured skillset in user settings */
export interface SkillsetConfig {
  id: string // deterministic slug from URL
  url: string // git clone URL
  name: string // from index.json skillset_name
  description: string // from index.json description
  addedAt: string // ISO date
}

// ============================================================================
// Installed Skill Metadata (stored alongside SKILL.md)
// ============================================================================

/** Metadata stored in .skillset-metadata.json alongside an installed skill */
export interface InstalledSkillMetadata {
  skillsetId: string
  skillsetUrl: string
  skillName: string // original name from index.json
  skillPath: string // path within skillset repo
  installedVersion: string
  installedAt: string // ISO date
  originalContentHash: string // SHA-256 of SKILL.md at install time
  openPrUrl?: string // URL of an open PR for local changes
}

// ============================================================================
// SKILL.md Frontmatter Metadata
// ============================================================================

/** A required environment variable declared in SKILL.md frontmatter */
export interface RequiredEnvVar {
  name: string
  description: string
}

/** Parsed metadata section from SKILL.md frontmatter */
export interface SkillFrontmatterMetadata {
  version?: string
  required_env_vars?: RequiredEnvVar[]
}

// ============================================================================
// Skill Status
// ============================================================================

/** Skill status for UI display */
export type SkillStatus =
  | { type: 'local' }
  | { type: 'up_to_date'; skillsetId: string; skillsetName: string }
  | { type: 'update_available'; skillsetId: string; skillsetName: string; latestVersion: string }
  | { type: 'locally_modified'; skillsetId: string; skillsetName: string; openPrUrl?: string }

/** Extended skill info with status */
export interface SkillWithStatus {
  name: string
  description: string
  path: string // directory name under .claude/skills/
  status: SkillStatus
}

/** A skill available from a skillset that is not yet installed */
export interface DiscoverableSkill {
  skillsetId: string
  skillsetName: string
  name: string
  description: string
  version: string
  path: string // path within skillset repo
  requiredEnvVars?: RequiredEnvVar[]
}

// ============================================================================
// Agent Template Types (for skillset-based agent sharing)
// ============================================================================

/** An agent entry within a skillset's index.json */
export interface SkillsetIndexAgent {
  name: string
  path: string // e.g. "agents/research-assistant/"
  description: string
  version: string
}

/** Metadata stored in workspace/.skillset-agent-metadata.json */
export interface InstalledAgentMetadata {
  skillsetId: string
  skillsetUrl: string
  agentName: string
  agentPath: string // path within skillset repo
  installedVersion: string
  installedAt: string // ISO date
  originalContentHash: string // SHA-256 of template-eligible files
  openPrUrl?: string
}

/** Agent template status (mirrors SkillStatus) */
export type AgentTemplateStatus =
  | { type: 'local' }
  | { type: 'up_to_date'; skillsetId: string; skillsetName: string }
  | { type: 'update_available'; skillsetId: string; skillsetName: string; latestVersion: string }
  | { type: 'locally_modified'; skillsetId: string; skillsetName: string; openPrUrl?: string }

/** An agent available from a skillset that is not yet installed */
export interface DiscoverableAgent {
  skillsetId: string
  skillsetName: string
  name: string
  description: string
  version: string
  path: string // path within skillset repo
}
