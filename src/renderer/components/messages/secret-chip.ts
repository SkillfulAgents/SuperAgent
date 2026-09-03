import { secretDisplayText } from '@renderer/lib/secret-detection'
import { formatChipMarker, parseChipMarker } from './chip-marker'
import type { ComposerChipKind } from './composer-chips'

export const secretChip: ComposerChipKind = {
  kind: 'secret',
  composer: {
    raw: (chip) => formatChipMarker('secret', chip.payload.envVar, chip.payload.key),
    parse: (raw) => {
      const parts = parseChipMarker(raw)
      if (!parts || parts.kind !== 'secret') return null
      return { kind: 'secret', payload: { envVar: parts.referent, key: parts.label } }
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
