import type { ComponentType, ForwardRefExoticComponent, ReactNode, RefAttributes } from 'react'
import type { DOMOutputSpec } from 'prosemirror-model'
import type { QueryClient } from '@tanstack/react-query'
import type { AgentAvatar } from '@shared/lib/types/agent-avatar'
import { appendMentions, parseMentions, type Mention } from '@shared/lib/utils/mentions'
import { parseDictationNote } from '@shared/lib/utils/dictation-note'
import { CHIP_MARKER, CHIP_MARKER_STICKY, chipFromMatch, formatChipMarker, type Chip } from '@renderer/lib/chip-marker'
import { secretChip } from './secret-chip'
import { agentChip, mentionTrigger, userChip } from './mention-chips'

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

/** What a kind's `beforeSend` works with. */
export interface ChipSend {
  /** The agent the draft is for. */
  agentSlug: string
  /** What the composer knows, with what the checks before this one learned. */
  context: ChipContext
  /** The message only notifies: it runs no turn. */
  silent: boolean
  isAuthMode: boolean
  /** Whether the person may share the agent and set what it may reach. */
  manages: boolean
  queryClient: QueryClient
  /** Shows a dialog until it calls `done`; resolves with whether the person went ahead. */
  ask: (dialog: (done: (ok: boolean) => void) => ReactNode) => Promise<boolean>
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
  /**
   * Before a draft with chips of this kind is sent, given its distinct ones:
   * may check them and ask the person something (offer access). Resolves to
   * the context to send with, or null to keep the draft.
   */
  beforeSend?: (chips: Chip[], send: ChipSend) => Promise<ChipContext | null>
  /**
   * A draft that opens on this kind's chip only notifies who it names: it joins
   * the transcript and the agent does not run, where the composer allows that.
   */
  opensSilently?: boolean
}

export const COMPOSER_CHIP_KINDS: readonly ComposerChipKind[] = [secretChip, userChip, agentChip]

/** What a trigger's picker receives. It shows at the caret while the query is typed. */
export interface ChipPickerProps {
  /** What was typed after the trigger character. */
  query: string
  context: ChipContext
  /** Where the trigger character sits. */
  anchor: { getBoundingClientRect: () => DOMRect }
  /** Puts the chip where the trigger and its query were. */
  onPick: (chip: Chip) => void
  /** Closes the picker until the caret leaves this trigger. */
  onDismiss: () => void
}

/** An open picker sees the editor's keys first. */
export interface ChipPickerHandle {
  /** True when the picker took the key. */
  onKeyDown: (event: KeyboardEvent) => boolean
}

/**
 * A character that, typed at the start of a line or after a space, opens a
 * picker of chips to put in its place. A new trigger is a line in
 * `COMPOSER_CHIP_TRIGGERS`; its picker can offer chips of several kinds.
 */
export interface ComposerChipTrigger {
  char: string
  /** Whether the composer has anything to pick from. */
  available: (context: ChipContext) => boolean
  Picker: ForwardRefExoticComponent<ChipPickerProps & RefAttributes<ChipPickerHandle>>
}

export const COMPOSER_CHIP_TRIGGERS: readonly ComposerChipTrigger[] = [mentionTrigger]

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

/** The chip a draft opens on, when its kind makes the draft only notify (`opensSilently`). */
export function silentOpener(text: string): Chip | null {
  const opening = chipAt(text.trimStart())?.chip
  return opening && getChipKind(opening)?.opensSilently ? opening : null
}

/**
 * Runs each kind's `beforeSend` on the draft's chips of that kind, in
 * `COMPOSER_CHIP_KINDS` order, each with the context the one before resolved
 * to. Null when one of them kept the draft.
 */
export async function checkBeforeSend(text: string, send: ChipSend): Promise<ChipContext | null> {
  const chips = [...new Map(chipsIn(text).map((chip) => [`${chip.kind}:${chip.referent}`, chip])).values()]
  let context: ChipContext | null = send.context
  for (const kind of COMPOSER_CHIP_KINDS) {
    const own = chips.filter((chip) => chip.kind === kind.kind)
    if (!kind.beforeSend || own.length === 0) continue
    context = await kind.beforeSend(own, { ...send, context })
    if (!context) return null
  }
  return context
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

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A sent message as a draft again, for one that comes back to the composer:
 * the dictation note goes, each `@Name` its mentions block lists is the chip
 * it was, and the block goes. `agentId` turns the slug the block gives an
 * agent back into its id.
 */
export function draftFromAgentText(text: string, agentId: (slug: string) => string): string {
  const { cleanText: sent } = parseDictationNote(text)
  const { cleanText, mentions } = parseMentions(sent)
  if (mentions.length === 0) return sent
  const markers = new Map(mentions.map((mention) => [mention.name, formatChipMarker(mention.kind === 'user'
    ? { kind: userChip.kind, referent: mention.id, label: mention.name }
    : { kind: agentChip.kind, referent: agentId(mention.slug), label: mention.name })]))
  // Longer names first, so `@Ann Lee` is not read as `@Ann`.
  const names = [...markers.keys()].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`@(${names.map(escapeRegExp).join('|')})`, 'g')
  return cleanText.replace(pattern, (_match, name: string) => markers.get(name)!)
}
