import type { FileOps } from '@shared/lib/agent-actor/types'

/**
 * What the container layer needs from the agent layer above it: a way to
 * reach an agent's workspace when a container starts. The runtime seeds the
 * container browser from the selected Chrome profile and reads the agent's
 * display name for the LLM provider's attribution, and neither may go by
 * host path, because the workspace is wherever the agent's actor says it is.
 *
 * The agent registry attaches an implementation to the container host when
 * it is created (`createAgentRegistry`), so the port is wired by the package
 * that owns the actors rather than by an entry point that could forget.
 */
export interface AgentWorkspaceAccess {
  /** The agent's workspace file operations. */
  files(slug: string): FileOps
  /** The agent's instructions document (`CLAUDE.md`), or null when it has none. */
  instructions(slug: string): Promise<string | null>
}
