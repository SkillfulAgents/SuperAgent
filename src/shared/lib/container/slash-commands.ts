import type { SlashCommandInfo } from './types'

function commandIdentity(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Use CLI-provided executable names while retaining SDK-provided help text. */
export function mergeCanonicalSlashCommands(
  canonicalNames: readonly string[],
  richCommands: readonly SlashCommandInfo[],
): SlashCommandInfo[] {
  if (canonicalNames.length === 0) return [...richCommands]

  const byExactName = new Map(richCommands.map((command) => [command.name, command]))
  const byIdentity = new Map<string, SlashCommandInfo | null>()

  for (const command of richCommands) {
    const identity = commandIdentity(command.name)
    if (!identity) continue
    byIdentity.set(identity, byIdentity.has(identity) ? null : command)
  }

  return canonicalNames.map((name) => {
    const details = byExactName.get(name) ?? byIdentity.get(commandIdentity(name)) ?? undefined
    return {
      name,
      description: details?.description ?? '',
      argumentHint: details?.argumentHint ?? '',
    }
  })
}

/**
 * Old session metadata stored SDK display titles as command names. Repair the
 * known-invalid whitespace form lazily so cold sessions created before the
 * canonical-name fix remain usable and keep their descriptions.
 */
export function repairLegacySlashCommands(
  commands: readonly SlashCommandInfo[],
): { commands: SlashCommandInfo[]; changed: boolean } {
  let changed = false
  const repaired = commands.map((command) => {
    if (!/\s/.test(command.name)) return command

    const name = command.name
      .split(':')
      .map((segment) => segment
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''))
      .filter(Boolean)
      .join(':')
    if (!name || name === command.name) return command

    changed = true
    return { ...command, name }
  })

  return { commands: repaired, changed }
}
