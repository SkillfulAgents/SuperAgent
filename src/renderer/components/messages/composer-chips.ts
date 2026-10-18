import type { DOMOutputSpec } from 'prosemirror-model'
import { CHIP_MARKER, CHIP_MARKER_STICKY, chipFromMatch, type Chip } from '@renderer/lib/chip-marker'
import { secretChip } from './secret-chip'

/** What the composer knows about its agent, for kinds whose referent can go away. */
export interface ChipContext {
  /** Env vars of the agent's saved secrets; undefined until they load. */
  secretEnvVars?: ReadonlySet<string>
}

/**
 * One kind of inline chip in the composer. The editor paints it as an atom, the
 * draft stores it as its marker, and send swaps the marker for `toAgentText`.
 * A new kind is a file plus a line in `COMPOSER_CHIP_KINDS`.
 */
export interface ComposerChipKind {
  kind: string
  /** The referents this kind accepts. Any other marker of this kind stays text. */
  referent: RegExp
  /** The chip's contents in the composer. */
  render: (chip: Chip) => DOMOutputSpec
  /** What the agent receives in place of the marker. Omitted, the marker itself. */
  toAgentText?: (chip: Chip) => string
  /**
   * False once the referent is gone (a deleted key). The composer flags the chip
   * and send keeps its marker rather than claim something that is not there.
   */
  isBacked?: (chip: Chip, context: ChipContext) => boolean
}

export const COMPOSER_CHIP_KINDS: readonly ComposerChipKind[] = [secretChip]

const kindsByName = new Map(COMPOSER_CHIP_KINDS.map((kind) => [kind.kind, kind]))

/** The chip a marker match stands for, or null when no registered kind accepts it. */
export function registeredChip(match: readonly string[]): Chip | null {
  const chip = chipFromMatch(match)
  return chip && kindsByName.get(chip.kind)?.referent.test(chip.referent) ? chip : null
}

/** The registered chip whose marker starts at `pos`, and the marker's length. */
export function chipAt(text: string, pos = 0): { chip: Chip; length: number } | null {
  CHIP_MARKER_STICKY.lastIndex = pos
  const match = CHIP_MARKER_STICKY.exec(text)
  const chip = match && registeredChip(match)
  return chip ? { chip, length: match[0].length } : null
}

export function getChipKind(chip: Chip): ComposerChipKind | undefined {
  return kindsByName.get(chip.kind)
}

export function isChipBacked(chip: Chip, context: ChipContext): boolean {
  return getChipKind(chip)?.isBacked?.(chip, context) ?? true
}

/** The draft as the agent receives it: each backed chip's marker replaced by its agent text. */
export function chipsToAgentText(text: string, context: ChipContext): string {
  return text.replace(CHIP_MARKER, (marker: string, kind: string, referent: string, label: string) => {
    const chip = registeredChip([marker, kind, referent, label])
    if (!chip || !isChipBacked(chip, context)) return marker
    return getChipKind(chip)?.toAgentText?.(chip) ?? marker
  })
}
