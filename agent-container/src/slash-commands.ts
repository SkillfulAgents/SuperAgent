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
// Only built-ins whose result the app renders belong here. /context, /recap and
// /reload-skills run, but their output never reaches the chat. /goal keeps the
// agent working past the turn end the host waits for. /security-review,
// /insights and /team-onboarding are Claude Code developer workflows, which is
// also why createQuery turns off the CLI's bundled skills.
const SUPPORTED_BUILTIN_COMMANDS: ReadonlySet<string> = new Set(['compact']);

// Stands in for the CLI's list when it cannot be read, so the built-in that
// breaks the host's session stays blocked.
const SESSION_BREAKING_BUILTINS: readonly SlashCommand[] = [
  { name: 'clear', description: '', argumentHint: '', aliases: ['reset', 'new'], builtin: true },
];

/**
 * Names and aliases of the CLI built-ins that Gamut does not support.
 *
 * `runnableNames` are system/init's `slash_commands`, the names the CLI runs as
 * typed. A skill named like a built-in's alias is listed there, and the CLI
 * runs it instead of the built-in. The command list cannot show that: it lists
 * a skill under its display title ("Reset Board" for /reset). Before the first
 * system/init, the list's own non-built-in names stand in.
 */
export function unsupportedBuiltinCommands(
  commands: readonly SlashCommand[] | undefined,
  runnableNames?: readonly string[],
): Set<string> {
  const builtins = commands ?? SESSION_BREAKING_BUILTINS;
  const taken = new Set(runnableNames ?? builtins.filter((command) => !command.builtin).map((command) => command.name));
  const names = new Set<string>();
  for (const command of builtins) {
    if (!command.builtin || SUPPORTED_BUILTIN_COMMANDS.has(command.name)) continue;
    names.add(command.name);
    for (const alias of command.aliases ?? []) {
      if (!taken.has(alias)) names.add(alias);
    }
  }
  return names;
}

/** Whether the CLI would run `text` as one of the `unsupported` built-ins. */
export function isUnsupportedCommand(text: string, unsupported: ReadonlySet<string>): boolean {
  // The CLI runs a slash command only when the text starts with it.
  const name = /^\/(\S+)/.exec(text)?.[1];
  return name !== undefined && unsupported.has(name);
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
