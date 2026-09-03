import type { DOMOutputSpec } from 'prosemirror-model'
import { CHIP_MARKER } from './chip-marker'
import { secretChip } from './secret-chip'

export { CHIP_MARKER, formatChipMarker, parseChipMarker } from './chip-marker'
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

export function rewriteChipsForSend(text: string): string {
  const byKind = new Map(COMPOSER_CHIP_KINDS.map((kind) => [kind.kind, kind]))
  return text.replace(
    CHIP_MARKER,
    (raw, kindName: string) => {
      const kind = byKind.get(kindName)
      if (!kind) return raw
      const chip = kind.composer.parse(raw)
      if (!chip) return raw
      return kind.transcript?.raw?.(chip) ?? raw
    }
  )
}
