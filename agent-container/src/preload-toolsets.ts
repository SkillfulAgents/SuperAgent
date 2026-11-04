import { z } from 'zod';

/**
 * Toolsets a session can have in the prompt from its first turn instead of
 * deferred behind ToolSearch, for a session started to do one thing (the
 * launcher's computer-use toggle). Each is the name of the in-process MCP
 * server that carries it. Adding one: name it here and give its server
 * `alwaysLoad` in ClaudeCodeProcess.buildSdkMcpServers.
 */
export const PRELOAD_TOOLSETS = ['computer-use'] as const;

export type PreloadToolset = (typeof PRELOAD_TOOLSETS)[number];

/**
 * The toolsets this build knows, once each in PRELOAD_TOOLSETS order, or
 * undefined when none. Unknown names are dropped, not refused: a host newer
 * than this image may ask for a toolset the image doesn't have, and the
 * session still starts. One order because the list is part of the
 * warm-profile key, where array order counts.
 */
export function knownPreloadToolsets(names: readonly string[] | undefined): PreloadToolset[] | undefined {
  const known = PRELOAD_TOOLSETS.filter((toolset) => names?.includes(toolset));
  return known.length > 0 ? known : undefined;
}

export const preloadToolsetsSchema = z.array(z.string()).optional().transform(knownPreloadToolsets);
