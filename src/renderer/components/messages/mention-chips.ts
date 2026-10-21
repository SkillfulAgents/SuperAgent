import type { DOMOutputSpec } from 'prosemirror-model'
import { mentionName } from '@shared/lib/utils/mentions'
import type { Chip } from '@renderer/lib/chip-marker'
import type { ComposerChipKind, ComposerChipTrigger } from './composer-chips'
import { AgentMentionIcon, ChatMentionIcon, MENTION_CHIP_CLASS, UserMentionIcon, agentForSlug } from './mention-chip'
import { offerReach, offerShare } from './mention-access-gate'
import { MentionMenu } from './mention-menu'

function renderMention(testId: string) {
  return (chip: Chip): DOMOutputSpec => ['span', { 'data-testid': testId, class: MENTION_CHIP_CLASS },
    ['span', { 'data-chip-icon': '' }],
    `@${mentionName(chip.label)}`,
  ]
}

/** The `@Name` the agent reads where a mention stood; the list after the message says who it is. */
const toAgentText = (chip: Chip) => `@${mentionName(chip.label)}`

/** A teammate: the referent is their user id, the label their name. */
export const userChip: ComposerChipKind = {
  kind: 'user',
  referent: /^[A-Za-z0-9_-]+$/,
  render: renderMention('user-mention'),
  Icon: UserMentionIcon,
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
  render: renderMention('agent-mention'),
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

/** One of this agent's chats: the referent is its session id, the label its title. */
export const chatChip: ComposerChipKind = {
  kind: 'chat',
  referent: /^[A-Za-z0-9_-]+$/,
  render: renderMention('chat-mention'),
  Icon: ChatMentionIcon,
  toAgentText,
  mention: (chip) => ({ kind: 'chat', id: chip.referent, name: chip.label }),
}

/** `@` picks a teammate, another agent, or one of this agent's chats. */
export const mentionTrigger: ComposerChipTrigger = {
  char: '@',
  available: ({ agentSlug }) => !!agentSlug,
  Picker: MentionMenu,
}
