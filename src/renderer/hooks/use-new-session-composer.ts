import { useCallback } from 'react'
import { useComposerOptions, type UseComposerOptionsArgs } from '@renderer/components/messages/composer-options'
import type { Attachment, ReferenceAttachment } from '@renderer/components/messages/attachment-preview'
import { apiFetch } from '@renderer/lib/api'
import { uploadFileChunked, type UploadProgress } from '@renderer/lib/upload'
import { useAgentPreferences } from './use-agent-preferences'
import { useMessageComposer } from './use-message-composer'
import { useCreateSession } from './use-sessions'

type CreatedSession = Awaited<ReturnType<ReturnType<typeof useCreateSession>['mutateAsync']>>

interface NewSessionComposerOptions {
  /** Empty until a surface with an agent picker has selected one. */
  agentSlug: string
  draftKey: string
  initialAttachments?: Attachment[]
  references?: readonly ReferenceAttachment[]
  initialOptions?: Pick<UseComposerOptionsArgs, 'initialModel' | 'initialLlmProviderId' | 'initialEffort' | 'initialSpeed'>
  followDefaults?: boolean
  /** Dispatch waits for each selected agent's preferences before locking its defaults. */
  waitForAgentDefaults?: boolean
  /** Surface-specific guards, such as runtime readiness. */
  submitDisabled?: boolean
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
  initialAttachments,
  references,
  initialOptions,
  followDefaults,
  waitForAgentDefaults = false,
  submitDisabled = false,
  agentRuntimeErrorsShownInline,
  onSessionCreated,
  onError,
}: NewSessionComposerOptions) {
  const { data: agentPrefs, isFetched } = useAgentPreferences(agentSlug)
  const composerOptions = useComposerOptions({
    ...initialOptions,
    agentDefaultModel: agentPrefs?.defaultModel,
    agentDefaultLlmProviderId: agentPrefs?.defaultLlmProviderId,
    agentDefaultEffort: agentPrefs?.defaultEffort,
    agentDefaultSpeed: agentPrefs?.defaultSpeed,
    agentKey: agentSlug,
    agentDefaultsReady: waitForAgentDefaults ? isFetched : undefined,
    followDefaults,
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
        const session = await createSession.mutateAsync({ agentSlug, message: content, ...composerOptions.toRuntimeOptions() })
        await onSessionCreated({ agentSlug, session, content })
      } catch (error) {
        onError?.(error)
        throw error // useMessageComposer preserves the draft on failure.
      }
    }, [agentSlug, createSession, composerOptions, onSessionCreated, onError]),
    submitDisabled: disabled,
    keepMessageUntilComplete: true,
    draftKey,
    initialAttachments,
    references,
  })

  return { composer, composerOptions, createSession, isDisabled: disabled || composer.isUploading }
}
