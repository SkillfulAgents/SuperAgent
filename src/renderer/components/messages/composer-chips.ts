import type { DOMOutputSpec } from 'prosemirror-model'
import { CHIP_MARKER } from './chip-marker'
import { secretChip } from './secret-chip'

export {
  CHIP_MARKER,
  CHIP_MARKER_ANCHORED,
  CHIP_MARKER_STICKY,
  formatChipMarker,
  parseChipMarker,
} from './chip-marker'
export { secretChip } from './secret-chip'

export interface Chip<P extends Record<string, string> = Record<string, string>> {
  kind: string
  payload: P
}

export interface ChipSurface<P extends Record<string, string>, Paint> {
  raw: (chip: Chip<P>) => string
  parse: (raw: string) => Chip<P> | null
  render: (chip: Chip<P>) => Paint
}

export interface ComposerChipKind<P extends Record<string, string> = Record<string, string>> {
  kind: string
  composer: ChipSurface<P, DOMOutputSpec>
  transcript?: Partial<ChipSurface<P, unknown>>
}

export const COMPOSER_CHIP_KINDS: readonly ComposerChipKind<Record<string, string>>[] = [secretChip]

const chipKindsByName = new Map(COMPOSER_CHIP_KINDS.map((kind) => [kind.kind, kind]))

export function getChipKind(name: string) {
  return chipKindsByName.get(name)
}

export function isBackedSecretChip(chip: Chip, knownSecretEnvVars: ReadonlySet<string>): boolean {
  return chip.kind !== 'secret' || knownSecretEnvVars.has(chip.payload.envVar)
}

export function rewriteChipsForSend(text: string, knownSecretEnvVars: Iterable<string>): string {
  const known = knownSecretEnvVars instanceof Set ? knownSecretEnvVars : new Set(knownSecretEnvVars)
  return text.replace(
    CHIP_MARKER,
    (raw, kindName: string) => {
      const kind = getChipKind(kindName)
      if (!kind) return raw
      const chip = kind.composer.parse(raw)
      if (!chip || !isBackedSecretChip(chip, known)) return raw
      return kind.transcript?.raw?.(chip) ?? raw
    }
  )
}
