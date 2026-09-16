import * as path from 'path';

/**
 * The Gamut plugin — the skills we ship (dashboards, widgets) and the
 * workflows we vendor (deep-research), packaged as a Claude Code plugin and
 * baked into the agent image. Every session loads it through the SDK
 * `plugins` option (see claude-code.ts buildQueryOptions()).
 *
 * Why a plugin, and why here: the CLI only discovers skills under
 * $CLAUDE_CONFIG_DIR (/workspace/.claude — agent-writable, on the per-agent
 * bind mount) and inside plugins. Files copied into ~/.claude are never read —
 * the dashboards/widgets skills sat there invisible to the model while the
 * system prompt told it to load them. A plugin directory outside /workspace
 * needs no runtime provisioning, cannot be edited or deleted by the agent, and
 * is exempt from `disableBundledSkills`. Its skills list as `gamut:<name>`;
 * the Skill tool also accepts the bare name.
 *
 * Source of truth: agent-container/plugin/ (see its README.md). The Dockerfile
 * copies it to DEFAULT_GAMUT_PLUGIN_DIR read-only. Override with
 * GAMUT_PLUGIN_DIR for tests and local runs.
 */
export const DEFAULT_GAMUT_PLUGIN_DIR = '/opt/gamut/plugin';

export function gamutPluginDir(): string {
  return process.env.GAMUT_PLUGIN_DIR || DEFAULT_GAMUT_PLUGIN_DIR;
}

/** Path inside the plugin's skills/ tree, e.g. gamutSkillPath('widgets', 'templates', 'basic'). */
export function gamutSkillPath(...segments: string[]): string {
  return path.join(gamutPluginDir(), 'skills', ...segments);
}
