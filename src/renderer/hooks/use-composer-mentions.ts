import { useMemo, type ReactNode } from 'react'
import type { ChipContext } from '@renderer/components/messages/composer-chips'
import { useMentionDirectory } from '@renderer/components/messages/mention-chip'
import { useMentionAccessGate } from '@renderer/components/messages/mention-access-gate'

/** What a composer that offers `@` hands useMessageComposer. */
export interface ComposerMentions {
  /** Who its chips can name, for the composer's ChipContext. */
  directory: Pick<ChipContext, 'members' | 'agents'>
  /**
   * A draft that opens on a teammate only notifies them, and the agent does
   * not run: for an existing session. A first message always runs the agent.
   */
  silent: boolean
  /** Offers access to whoever the draft tags. The context to send with, or null when the person backed out. */
  confirm: (content: string, context: ChipContext, options: { silent: boolean }) => Promise<ChipContext | null>
  /** The access prompt, for the composer to render. */
  dialog: ReactNode
}

export function useComposerMentions(agentSlug: string, { silent }: { silent: boolean }): ComposerMentions {
  const directory = useMentionDirectory(agentSlug)
  const { confirm, dialog } = useMentionAccessGate(agentSlug)
  return useMemo(() => ({ directory, silent, confirm, dialog }), [directory, silent, confirm, dialog])
}
