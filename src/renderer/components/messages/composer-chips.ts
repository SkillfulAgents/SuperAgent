import type { ComponentType } from 'react'
import type { DOMOutputSpec } from 'prosemirror-model'
import type { AgentAvatar } from '@shared/lib/types/agent-avatar'
import { appendMentions, parseMentions, type Mention } from '@shared/lib/utils/mentions'
import { CHIP_MARKER, CHIP_MARKER_STICKY, chipFromMatch, formatChipMarker, type Chip } from '@renderer/lib/chip-marker'
import { secretChip } from './secret-chip'
import { agentChip, userChip } from './mention-chips'

/** Someone who can open the agent. */
export interface ChipPerson {
  id: string
  name: string
  email?: string
  image?: string | null
}

/** Another agent, as the agents tools know it. */
export interface ChipAgent {
  slug: string
  displaySlug: string
  name: string
  avatar?: AgentAvatar | null
}

/** What the composer knows about its agent, for kinds whose referent can go away. */
export interface ChipContext {
  /** The agent the draft is for. */
  agentSlug?: string
  /** Env vars of the agent's saved secrets; undefined until they load. */
  secretEnvVars?: ReadonlySet<string>
  /** The people who can open the agent, by user id; undefined outside auth mode or until they load. */
  members?: ReadonlyMap<string, ChipPerson>
  /** The agents the viewer can see, by slug; undefined until they load. */
  agents?: ReadonlyMap<string, ChipAgent>
}

/** What a kind's right-click menu receives. It stays mounted until it calls `onClose`. */
export interface ChipMenuProps {
  chip: Chip
  context: ChipContext
  backed: boolean
  /** Where the chip was right-clicked, in viewport pixels. */
  anchor: { x: number; y: number }
  /** Swaps the right-clicked chip for another in the draft. */
  replace: (chip: Chip) => void
  onClose: () => void
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
  /**
   * The chip's contents in the composer. An element carrying `data-chip-icon`
   * is where the editor draws the kind's `Icon`.
   */
  render: (chip: Chip) => DOMOutputSpec
  /** Drawn into the chip's `data-chip-icon` element: React, so it can be an avatar. */
  Icon?: ComponentType<{ chip: Chip; context: ChipContext }>
  /** What the agent receives in place of the marker. Omitted, the marker itself. */
  toAgentText?: (chip: Chip) => string
  /** Who the chip names, listed for the agent after the message (see `appendMentions`). */
  mention?: (chip: Chip, context: ChipContext) => Mention
  /**
   * False once the referent is gone (a deleted key). The composer flags the chip
   * and send keeps its marker rather than claim something that is not there.
   */
  isBacked?: (chip: Chip, context: ChipContext) => boolean
  /** The chip's right-click menu, built on `ChipMenuAt`. Omitted, the browser's own. */
  Menu?: ComponentType<ChipMenuProps>
}

export const COMPOSER_CHIP_KINDS: readonly ComposerChipKind[] = [secretChip, userChip, agentChip]

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

/** The registered chips in a draft, in order. */
export function chipsIn(text: string): Chip[] {
  return [...text.matchAll(CHIP_MARKER)].flatMap((match) => registeredChip(match) ?? [])
}

/** The teammate a draft opens on: such a draft only notifies them, where the composer allows that. */
export function openingTeammate(text: string): Chip | null {
  const opening = chipAt(text.trimStart())?.chip
  return opening?.kind === userChip.kind ? opening : null
}

/**
 * The draft as the agent receives it: each backed chip's marker replaced by its
 * agent text, and the people and agents it names listed after it. `silent`
 * tells the agent the message only notified the teammates it tags.
 */
export function chipsToAgentText(text: string, context: ChipContext, { silent = false } = {}): string {
  const mentions = new Map<string, Mention>()
  const body = text.replace(CHIP_MARKER, (marker: string, kind: string, referent: string, label: string) => {
    const chip = registeredChip([marker, kind, referent, label])
    if (!chip || !isChipBacked(chip, context)) return marker
    const chipKind = getChipKind(chip)
    const mention = chipKind?.mention?.(chip, context)
    if (mention) mentions.set(`${chip.kind}:${chip.referent}`, mention)
    return chipKind?.toAgentText?.(chip) ?? marker
  })
  return appendMentions(body, [...mentions.values()], { silent })
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A sent message as a draft again, for one that comes back to the composer:
 * each `@Name` its mentions block lists is the chip it was, and the block
 * goes. `agentId` turns the slug the block gives an agent back into its id.
 */
export function draftFromAgentText(text: string, agentId: (slug: string) => string): string {
  const { cleanText, mentions } = parseMentions(text)
  if (mentions.length === 0) return text
  const markers = new Map(mentions.map((mention) => [mention.name, formatChipMarker(mention.kind === 'user'
    ? { kind: userChip.kind, referent: mention.id, label: mention.name }
    : { kind: agentChip.kind, referent: agentId(mention.slug), label: mention.name })]))
  // Longer names first, so `@Ann Lee` is not read as `@Ann`.
  const names = [...markers.keys()].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`@(${names.map(escapeRegExp).join('|')})`, 'g')
  return cleanText.replace(pattern, (_match, name: string) => markers.get(name)!)
}
