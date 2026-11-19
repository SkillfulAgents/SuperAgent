import type { DOMOutputSpec } from 'prosemirror-model'
import { mentionName } from '@shared/lib/utils/mentions'
import type { Chip } from '@renderer/lib/chip-marker'
import type { ComposerChipKind, ComposerChipTrigger } from './composer-chips'
import { AgentMentionIcon, MENTION_AT_CLASS, MENTION_CHIP_CLASS, agentForSlug } from './mention-chip'
import { offerReach, offerShare } from './mention-access-gate'
import { MentionMenu } from './mention-menu'

/** A teammate's chip is just their name; an agent's leads with its icon, drawn into the empty span. */
function renderMention(testId: string, { icon }: { icon: boolean }) {
  return (chip: Chip): DOMOutputSpec => ['span', { 'data-testid': testId, class: MENTION_CHIP_CLASS },
    ...(icon ? [['span', { 'data-chip-icon': '' }] as DOMOutputSpec] : []),
    // One span for the @ and the name, so the chip's gap stays between icon and text.
    ['span', ['span', { class: MENTION_AT_CLASS }, '@'], mentionName(chip.label)],
  ]
}

/** The `@Name` the agent reads where a mention stood; the list after the message says who it is. */
const toAgentText = (chip: Chip) => `@${mentionName(chip.label)}`

/** A teammate: the referent is their user id, the label their name. */
export const userChip: ComposerChipKind = {
  kind: 'user',
  referent: /^[A-Za-z0-9_-]+$/,
  render: renderMention('user-mention', { icon: false }),
  toAgentText,
  mention: (chip, { members }) => {
    const email = members?.get(chip.referent)?.email
    return { kind: 'user', id: chip.referent, name: chip.label, ...(email ? { email } : {}) }
  },
  beforeSend: offerShare,
  // "@Mike look at this" is for Mike, not the agent.
  opensSilently: true,
}

/** Another agent: the referent is its id, the label its name. */
export const agentChip: ComposerChipKind = {
  kind: 'agent',
  referent: /^[a-z0-9-]+$/,
  render: renderMention('agent-mention', { icon: true }),
  Icon: AgentMentionIcon,
  toAgentText,
  // The display slug, as list_agents prints it; the tools resolve either.
  mention: (chip, { agents }) => ({
    kind: 'agent',
    slug: agentForSlug(agents, chip.referent)?.displaySlug ?? chip.referent,
    name: chip.label,
  }),
  isBacked: (chip, { agents }) => !agents || !!agentForSlug(agents, chip.referent),
  beforeSend: offerReach,
}

/** `@` picks a teammate or another agent. */
export const mentionTrigger: ComposerChipTrigger = {
  char: '@',
  available: ({ agentSlug }) => !!agentSlug,
  Picker: MentionMenu,
}
