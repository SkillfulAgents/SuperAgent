import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';

export interface SlashCommandDetails {
  name: string;
  description: string;
  argumentHint: string;
}

/**
 * CLI built-ins that fit a Gamut session. Every other built-in (for example
 * /clear, which starts a new CLI session the host never sees, or /model, which
 * bypasses the model picker) is hidden from the menu and sent as plain text.
 * Skills and custom commands are not built-ins and are never affected.
 */
const SUPPORTED_BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
  'compact',
  'context',
  'recap',
  'reload-skills',
  'security-review',
]);

/** Names and aliases of the CLI built-ins that Gamut does not support. */
export function unsupportedBuiltinCommands(commands: readonly SlashCommand[]): Set<string> {
  const names = new Set<string>();
  for (const command of commands) {
    if (!command.builtin || SUPPORTED_BUILTIN_COMMANDS.has(command.name)) continue;
    names.add(command.name);
    for (const alias of command.aliases ?? []) names.add(alias);
  }
  return names;
}

/**
 * The CLI runs a slash command only when the text starts with it, so a leading
 * space makes an unsupported built-in reach the model as a plain message.
 */
export function makeUnsupportedCommandInert(text: string, unsupported: ReadonlySet<string>): string {
  const name = /^\/(\S+)/.exec(text)?.[1];
  return name !== undefined && unsupported.has(name) ? ` ${text}` : text;
}

function commandIdentity(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Keep the CLI init event's executable command names while enriching them with
 * the SDK control response's descriptions and argument hints. For skills, the
 * latter may expose a display title ("Order Canvas Print") where the former
 * exposes the invocable slug ("order-canvas-print").
 */
export function mergeCanonicalSlashCommands(
  canonicalNames: readonly string[],
  richCommands: readonly SlashCommandDetails[],
): SlashCommandDetails[] {
  if (canonicalNames.length === 0) return [...richCommands];

  const byExactName = new Map(richCommands.map((command) => [command.name, command]));
  const byIdentity = new Map<string, SlashCommandDetails | null>();

  for (const command of richCommands) {
    const identity = commandIdentity(command.name);
    if (!identity) continue;
    byIdentity.set(identity, byIdentity.has(identity) ? null : command);
  }

  return canonicalNames.map((name) => {
    const details = byExactName.get(name) ?? byIdentity.get(commandIdentity(name)) ?? undefined;
    return {
      name,
      description: details?.description ?? '',
      argumentHint: details?.argumentHint ?? '',
    };
  });
}
