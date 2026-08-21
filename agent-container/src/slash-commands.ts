export interface SlashCommandDetails {
  name: string;
  description: string;
  argumentHint: string;
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
