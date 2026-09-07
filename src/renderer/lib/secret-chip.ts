import { isKnownSecret, parseSecretMarker, secretDisplayText } from './secret-detection'
import { formatChipMarker } from './chip-marker'
import type { ComposerChipKind } from '@renderer/components/messages/composer-chips'

export const secretChip: ComposerChipKind = {
  kind: 'secret',
  isBacked: (chip, knownSecrets) => isKnownSecret(chip.payload, knownSecrets),
  composer: {
    raw: (chip) => formatChipMarker('secret', chip.payload.envVar, chip.payload.key),
    parse: (raw) => {
      const parsed = parseSecretMarker(raw)
      if (!parsed) return null
      return { kind: 'secret', payload: parsed }
    },
    render: (chip) => ['span', {
      'data-testid': 'secured-secret',
      class: 'rounded-[3px] bg-amber-500/10 outline outline-1 outline-amber-500/70',
      contenteditable: 'false',
    }, secretDisplayText(chip.payload.key)],
  },
  transcript: {
    raw: (chip) => `[Key saved to .env - ${chip.payload.envVar}]`,
  },
}
