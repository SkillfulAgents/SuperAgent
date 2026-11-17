/**
 * What the container layer needs from the agent layer above it: a way to
 * reach an agent's workspace when a container starts. The runtime reads the
 * agent's display name for the LLM provider's attribution, and may not go by
 * host path, because the workspace is wherever the agent's actor says it is.
 *
 * The agent registry attaches an implementation to the container host when
 * it is created (`createAgentRegistry`), so the port is wired by the package
 * that owns the actors rather than by an entry point that could forget.
 */
export interface AgentWorkspaceAccess {
  /** The agent's instructions document (`AGENTS.md`), or null when it has none. */
  instructions(slug: string): Promise<string | null>
}
