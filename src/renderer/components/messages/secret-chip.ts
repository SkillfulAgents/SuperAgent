import { formatChipMarker } from '@renderer/lib/chip-marker'
import type { ComposerChipKind } from './composer-chips'

/** A key saved to the agent's `.env`: the referent is its env var, the label its name. */
export const secretChip: ComposerChipKind = {
  kind: 'secret',
  // What keyToEnvVar produces.
  referent: /^[A-Z0-9_]+$/,
  render: (chip) => ['span', {
    'data-testid': 'secured-secret',
    class: 'rounded-[3px] bg-amber-500/10 outline outline-1 outline-amber-500/70',
  }, `[${chip.label} | *********]`],
  toAgentText: (chip) => `[Key saved to .env - ${chip.referent}]`,
  isBacked: (chip, { secretEnvVars }) => !secretEnvVars || secretEnvVars.has(chip.referent),
}

export function secretMarker(secret: { key: string; envVar: string }): string {
  return formatChipMarker({ kind: 'secret', referent: secret.envVar, label: secret.key })
}
