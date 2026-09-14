/**
 * The agent's configuration documents: which workspace file each one is, how
 * it is encoded, and the Zod schema a JSON document must satisfy at the
 * boundary. `ConfigOps` reads and writes these through `FileOps`, so a
 * remote actor gets them for free once it has files.
 */
import type { z } from 'zod'
import { agentPreferencesSchema } from '@shared/lib/types/agent-preferences'
import { claudeSettingsWithHooksSchema } from '@shared/lib/services/agent-hooks-schema'
import { InstalledAgentMetadataSchema } from '@shared/lib/types/skillset-schema'

/**
 * Which skillset template an agent was installed from. Strict on the fields
 * the template service reads; a key this build does not know survives a
 * read-modify-write instead of being dropped.
 */
const installedAgentMetadataSchema = InstalledAgentMetadataSchema.loose()

interface TextDocSpec {
  kind: 'text'
  /** Workspace path of the document. */
  path: string
  /**
   * Whether another process (the agent's container) also writes this file, so
   * a read-modify-write has to be serialized across processes, not only within
   * this one.
   */
  shared: boolean
  /** File mode a filesystem implementation applies on write (the container must read `.env`). */
  mode?: number
}

interface JsonDocSpec<T> {
  kind: 'json'
  path: string
  shared: boolean
  schema: z.ZodType<T>
}

export type ConfigDocSpec = TextDocSpec | JsonDocSpec<unknown>

export const CONFIG_DOCS = {
  /** The agent's `CLAUDE.md`: frontmatter (name, description, createdAt) plus instructions. */
  instructions: { kind: 'text', path: 'CLAUDE.md', shared: false },
  /** The agent's `.env`. The container's `POST /env` writes it too, and must be able to read it. */
  secrets: { kind: 'text', path: '.env', shared: true, mode: 0o666 },
  /** Per-agent defaults for new sessions. */
  preferences: { kind: 'json', path: 'agent-preferences.json', shared: false, schema: agentPreferencesSchema },
  /** Claude Code settings, which is where hooks live. Unknown keys pass through. */
  claudeSettings: { kind: 'json', path: '.claude/settings.json', shared: false, schema: claudeSettingsWithHooksSchema },
  /** Which skillset template this agent came from and the hash of what was installed. Absent for a local agent. */
  skillsetMetadata: { kind: 'json', path: '.skillset-agent-metadata.json', shared: false, schema: installedAgentMetadataSchema },
} as const satisfies Record<string, ConfigDocSpec>

export type ConfigDocId = keyof typeof CONFIG_DOCS

/** The document's spec, widened to the union so shared fields are reachable. */
export function configDocSpec(id: ConfigDocId): ConfigDocSpec {
  return CONFIG_DOCS[id]
}

/** The file mode a filesystem implementation applies to this document, if any. */
export function configDocMode(id: ConfigDocId): number | undefined {
  const spec = configDocSpec(id)
  return spec.kind === 'text' ? spec.mode : undefined
}

/** The document type for an id: a string for text documents, the schema's output for JSON ones. */
export type ConfigDoc<K extends ConfigDocId> = (typeof CONFIG_DOCS)[K] extends { kind: 'json'; schema: z.ZodType<infer T> }
  ? T
  : string

export type ConfigDocErrorCode = 'corrupt' | 'invalid'

/**
 * A JSON document that cannot be used: `corrupt` when what is stored does not
 * parse or does not fit its schema (a read-modify-write must abort rather than
 * overwrite it), `invalid` when a caller tries to store something that does not
 * fit.
 */
export class ConfigDocError extends Error {
  constructor(
    readonly code: ConfigDocErrorCode,
    readonly docId: ConfigDocId,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(
      code === 'corrupt'
        ? `Refusing to use corrupt ${docId} document: ${reason}`
        : `Invalid ${docId} document: ${reason}`,
      options,
    )
    this.name = 'ConfigDocError'
  }
}
