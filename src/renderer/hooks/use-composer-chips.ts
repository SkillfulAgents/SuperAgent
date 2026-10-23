import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useUser } from '@renderer/context/user-context'
import { checkBeforeSend, type ChipContext, type ChipSend } from '@renderer/components/messages/composer-chips'
import { useMentionDirectory } from '@renderer/components/messages/mention-chip'
import { useAgentSecrets } from './use-secrets'

/**
 * The composer's side of its chips: what it knows about its agent for the kinds
 * (saved secrets, the people and agents a mention can name), and the kinds'
 * checks before a send, with the dialog one of them shows.
 */
export function useComposerChips(agentSlug: string, sessionId?: string | null): {
  context: ChipContext
  /** The context to send with, or null when the person backed out. */
  check: (text: string, options: { silent: boolean }) => Promise<ChipContext | null>
  dialog: ReactNode
} {
  const queryClient = useQueryClient()
  const { isAuthMode, isAdmin, canAdminAgent } = useUser()
  const { data: savedSecrets } = useAgentSecrets(agentSlug)
  const directory = useMentionDirectory(agentSlug)
  const context = useMemo<ChipContext>(
    () => ({ agentSlug, sessionId: sessionId ?? undefined, secretEnvVars: savedSecrets && new Set(savedSecrets.map((secret) => secret.envVar)), ...directory }),
    [agentSlug, sessionId, savedSecrets, directory]
  )
  const manages = !isAuthMode || isAdmin || canAdminAgent(agentSlug)
  const [dialog, setDialog] = useState<ReactNode>(null)

  const check = useCallback(async (text: string, { silent }: { silent: boolean }) => {
    if (!agentSlug) return context
    const ask: ChipSend['ask'] = (render) => new Promise((resolve) => setDialog(render((ok) => {
      setDialog(null)
      resolve(ok)
    })))
    return checkBeforeSend(text, { agentSlug, context, silent, isAuthMode, manages, queryClient, ask })
  }, [agentSlug, context, isAuthMode, manages, queryClient])

  return { context, check, dialog }
}
