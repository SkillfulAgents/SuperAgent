import { useCallback } from 'react'
import { useComposerOptions } from '@renderer/components/messages/composer-options'
import { agentDefaultRuntimeOptions } from '@shared/lib/container/runtime-options'
import type { ReferenceAttachment } from '@renderer/components/messages/attachment-preview'
import { useInheritedOptions } from '@renderer/context/drafts-context'
import { apiFetch } from '@renderer/lib/api'
import { appendComputerUseNote } from '@shared/lib/utils/computer-use-note'
import { uploadFileChunked, type UploadProgress } from '@renderer/lib/upload'
import { useAgentPreferences } from './use-agent-preferences'
import { useMessageComposer } from './use-message-composer'
import { useCreateSession } from './use-sessions'

type CreatedSession = Awaited<ReturnType<ReturnType<typeof useCreateSession>['mutateAsync']>>

interface NewSessionComposerOptions {
  /** Empty until a surface with an agent picker has selected one. */
  agentSlug: string
  /**
   * Where this composer keeps what is unsent: text, files and model picks. A
   * draft moved here (a stale session's Start Fresh) is what it starts with.
   */
  draftKey: string
  references?: readonly ReferenceAttachment[]
  followDefaults?: boolean
  /** Dispatch waits for each selected agent's preferences before locking its defaults. */
  waitForAgentDefaults?: boolean
  /** Surface-specific guards, such as runtime readiness. */
  submitDisabled?: boolean
  /**
   * Start the session with computer use on (the launcher's toggle): it may use
   * any app without asking, and the agent is told so, and which attachment is
   * the screenshot of the screen.
   */
  computerUse?: { screenshotName?: string }
  /** Analytics-only: names the launcher when it is not an agent's composer. */
  surface?: 'quick_dispatch'
  agentRuntimeErrorsShownInline?: boolean
  onSessionCreated: (result: { agentSlug: string; session: CreatedSession; content: string }) => void | Promise<void>
  onError?: (error: unknown) => void
}

/**
 * Start a conversation from Agent Home, Team Brain or the dispatch launcher.
 * Owns agent uploads, model defaults and submission; the caller owns its UI,
 * runtime policy and navigation (the launcher has no router).
 */
export function useNewSessionComposer({
  agentSlug,
  draftKey,
  references,
  followDefaults,
  waitForAgentDefaults = false,
  submitDisabled = false,
  computerUse,
  surface,
  agentRuntimeErrorsShownInline,
  onSessionCreated,
  onError,
}: NewSessionComposerOptions) {
  const { data: agentPrefs, isFetched } = useAgentPreferences(agentSlug)
  // The options of the session a draft was moved out of, for this visit only.
  const inheritedOptions = useInheritedOptions(draftKey)
  const composerOptions = useComposerOptions({
    initial: inheritedOptions,
    agentDefault: agentDefaultRuntimeOptions(agentPrefs),
    agentKey: agentSlug,
    agentDefaultsReady: waitForAgentDefaults ? isFetched : undefined,
    followDefaults,
    draftKey,
  })
  const createSession = useCreateSession({ agentRuntimeErrorsShownInline })
  const disabled = submitDisabled || createSession.isPending || !agentSlug
  const composer = useMessageComposer({
    agentSlug,
    uploadFile: useCallback(({ file, onProgress, signal, stallMs }: { file: File; onProgress?: (p: UploadProgress) => void; signal?: AbortSignal; stallMs?: number }) => {
      if (!agentSlug) return Promise.reject(new Error('No agent selected'))
      return uploadFileChunked<{ path: string }>({ url: `/api/agents/${agentSlug}/upload-file`, file, onProgress, signal, stallMs })
    }, [agentSlug]),
    uploadFolder: useCallback(async ({ sourcePath }: { sourcePath: string }) => {
      if (!agentSlug) throw new Error('No agent selected')
      const res = await apiFetch(`/api/agents/${agentSlug}/upload-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath }),
      })
      if (!res.ok) throw new Error('Failed to upload folder')
      return res.json() as Promise<{ path: string }>
    }, [agentSlug]),
    onSubmit: useCallback(async (content: string) => {
      if (!agentSlug) throw new Error('No agent selected')
      try {
        const runtimeOptions = composerOptions.toRuntimeOptions()
        const session = await createSession.mutateAsync({
          agentSlug,
          message: computerUse ? appendComputerUseNote(content, computerUse.screenshotName) : content,
          ...runtimeOptions,
          ...(computerUse ? { computerUse: true } : {}),
          ...(surface ? { surface } : {}),
        })
        // The session has the picks now, so they are no longer unsent.
        composerOptions.markSubmitted(runtimeOptions)
        await onSessionCreated({ agentSlug, session, content })
      } catch (error) {
        onError?.(error)
        throw error // useMessageComposer preserves the draft on failure.
      }
    }, [agentSlug, createSession, composerOptions, computerUse, surface, onSessionCreated, onError]),
    submitDisabled: disabled,
    keepMessageUntilComplete: true,
    draftKey,
    references,
  })

  return { composer, composerOptions, createSession, isDisabled: disabled || composer.isUploading }
}
