import type { DOMOutputSpec } from 'prosemirror-model'
import { CHIP_MARKER } from '@renderer/lib/chip-marker'
import { secretChip } from '@renderer/lib/secret-chip'

export {
  CHIP_MARKER,
  CHIP_MARKER_ANCHORED,
  CHIP_MARKER_STICKY,
  formatChipMarker,
  parseChipMarker,
} from '@renderer/lib/chip-marker'
export { secretChip } from '@renderer/lib/secret-chip'

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
  isBacked?: (chip: Chip<P>, knownSecrets: ReadonlyMap<string, string>) => boolean
}

export const COMPOSER_CHIP_KINDS: readonly ComposerChipKind<Record<string, string>>[] = [secretChip]

const chipKindsByName = new Map(COMPOSER_CHIP_KINDS.map((kind) => [kind.kind, kind]))

export function getChipKind(name: string) {
  return chipKindsByName.get(name)
}

export function isBackedChip(chip: Chip, knownSecrets: ReadonlyMap<string, string>): boolean {
  return getChipKind(chip.kind)?.isBacked?.(chip, knownSecrets) ?? true
}

export function rewriteChipsForSend(text: string, knownSecrets: ReadonlyMap<string, string>): string {
  return text.replace(
    CHIP_MARKER,
    (raw, kindName: string) => {
      const kind = getChipKind(kindName)
      if (!kind) return raw
      const chip = kind.composer.parse(raw)
      if (!chip || !isBackedChip(chip, knownSecrets)) return raw
      return kind.transcript?.raw?.(chip) ?? raw
    }
  )
}
