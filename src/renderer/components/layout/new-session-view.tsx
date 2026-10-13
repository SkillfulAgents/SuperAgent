import { useCallback } from 'react'
import { useCreateSession, useSessions } from '@renderer/hooks/use-sessions'
import { useAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import { useIsMobile } from '@renderer/hooks/use-mobile'
import { useRenameUntitledAgent } from '@renderer/hooks/use-rename-untitled-agent'
import { UNTITLED_AGENT_NAME } from '@renderer/hooks/use-create-untitled-agent'
import { useWarmStartOnType } from '@renderer/hooks/use-warm-start-on-type'
import { useWarmStartOnTypeEnabled } from '@renderer/hooks/use-settings'
import { usePendingMessages } from '@renderer/context/pending-messages-context'
import { useUser } from '@renderer/context/user-context'
import { uploadFileChunked, type UploadProgress } from '@renderer/lib/upload'
import { apiFetch } from '@renderer/lib/api'
import { ChatComposerBox, FLOATING_COMPOSER_CLASS } from '@renderer/components/messages/chat-composer-box'
import { ComposerActionButton } from '@renderer/components/messages/composer-action-button'
import { ComposerOptions, useComposerOptions } from '@renderer/components/messages/composer-options'
import { AgentDefaultFooter } from '@renderer/components/messages/agent-default-footer'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { UploadError } from '@renderer/components/ui/upload-error'
import { AgentRuntimeErrorView } from '@shared/lib/agent-runtime-errors/agent-runtime-error-view'
import type { ApiAgent } from '@renderer/hooks/use-agents'

const NOOP = () => {}

/**
 * The blank session leaf (`/agents/$slug/sessions/new`): an empty thread with
 * the session composer at its foot, focused on arrival. There is no session
 * yet — sending creates one with the message as its first turn and hands off
 * to AgentShell's `onSessionCreated`, which seeds the optimistic copy and
 * navigates to the real session. Same create path as the Agent Home composer.
 */
export function NewSessionView({ agent }: { agent: ApiAgent }) {
  const { onSessionCreated } = usePendingMessages()
  const { canUseAgent } = useUser()
  const isViewOnly = !canUseAgent(agent.slug)
  const isMobile = useIsMobile()
  const { data: sessions } = useSessions(agent.slug)
  const { data: agentPrefs } = useAgentPreferences(agent.slug)
  const composerOptions = useComposerOptions({
    agentDefaultModel: agentPrefs?.defaultModel,
    agentDefaultLlmProviderId: agentPrefs?.defaultLlmProviderId,
    agentDefaultEffort: agentPrefs?.defaultEffort,
    agentDefaultSpeed: agentPrefs?.defaultSpeed,
    agentKey: agent.slug,
    followDefaults: true,
  })
  const createSession = useCreateSession({ agentRuntimeErrorsShownInline: true })
  const renameUntitledAgent = useRenameUntitledAgent()
  const { data: runtimeStatus, isPending: isRuntimePending } = useRuntimeStatus()
  const isRuntimeReady = isRuntimePending || runtimeStatus?.runtimeReadiness?.status === 'READY'

  const composer = useMessageComposer({
    agentSlug: agent.slug,
    uploadFile: useCallback(({ file, onProgress, signal, stallMs }: { file: File; onProgress?: (p: UploadProgress) => void; signal?: AbortSignal; stallMs?: number }) => {
      return uploadFileChunked<{ path: string }>({ url: `/api/agents/${agent.slug}/upload-file`, file, onProgress, signal, stallMs })
    }, [agent.slug]),
    uploadFolder: useCallback(async ({ sourcePath }: { sourcePath: string }) => {
      const res = await apiFetch(`/api/agents/${agent.slug}/upload-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath }),
      })
      if (!res.ok) throw new Error('Failed to upload folder')
      return res.json() as Promise<{ path: string }>
    }, [agent.slug]),
    onSubmit: useCallback(async (content: string) => {
      const shouldRename = agent.name === UNTITLED_AGENT_NAME && (sessions?.length ?? 0) === 0
      const session = await createSession.mutateAsync({
        agentSlug: agent.slug,
        message: content,
        ...composerOptions.toRuntimeOptions(),
      })
      onSessionCreated(session.id, content, session.initialMessageUuid)
      if (shouldRename) renameUntitledAgent.mutate({ slug: agent.slug, prompt: content })
    }, [createSession, agent.slug, agent.name, sessions, composerOptions, onSessionCreated, renameUntitledAgent]),
    submitDisabled: createSession.isPending || !isRuntimeReady,
    keepMessageUntilComplete: true,
    draftKey: `new-session:${agent.slug}`,
  })

  const warmStartEnabled = useWarmStartOnTypeEnabled()
  useWarmStartOnType({ agentSlug: agent.slug, message: composer.message, enabled: warmStartEnabled })

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Touch keyboards insert a newline; the Send button sends (as in a session).
      if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) return
      e.preventDefault()
      if (!composer.canSubmit) return
      void composer.handleSubmit(e)
    }
  }

  const isDisabled = createSession.isPending || composer.isUploading || !isRuntimeReady

  if (isViewOnly) return <div className="flex-1" data-testid="new-session-view" />

  return (
    <div className="flex flex-1 min-h-0 flex-col justify-end bg-background" data-testid="new-session-view">
      <div className="mx-auto w-full max-w-[740px] pb-[env(safe-area-inset-bottom)]">
        <form
          onSubmit={composer.handleSubmit}
          className={`relative z-10 isolate px-4 pt-0 ${composer.isDragOver ? 'ring-2 ring-primary ring-inset' : ''}`}
          {...composer.dragHandlers}
        >
          <MountChoiceDialog
            open={composer.mountDialog.open}
            onChoice={composer.mountDialog.onChoice}
            folderName={composer.mountDialog.folderName}
          />
          <ChatComposerBox
            className={FLOATING_COMPOSER_CLASS}
            attachments={composer.attachments}
            onRemoveAttachment={composer.removeAttachment}
            onRetryAttachment={composer.retryAttachment}
            value={composer.message}
            onChange={composer.setMessage}
            onKeyDown={handleKeyDown}
            onPaste={composer.handlePaste}
            placeholder="Type a message..."
            disabled={isDisabled}
            rows={2}
            autoFocus={!isMobile}
            enterKeyHint="enter"
            dataTestId="new-session-input"
            secureSecrets={{
              agentSlug: agent.slug,
              potentialSecrets: composer.potentialSecrets,
              securedSecrets: composer.securedSecrets,
              onDismiss: composer.dismissPotentialSecret,
              onSecure: composer.securePotentialSecret,
              onRemove: composer.removeSecuredSecrets,
            }}
            leftActions={(
              <>
                <AttachmentPicker
                  onFileSelect={composer.handleFileSelect}
                  onFolderSelect={composer.handleFolderSelect}
                  onRecentFileAttach={(file) => composer.addFiles([{ file }])}
                  disabled={isDisabled}
                />
                <ComposerOptions
                  state={composerOptions}
                  disabled={isDisabled}
                  footer={<AgentDefaultFooter agentSlug={agent.slug} state={composerOptions} />}
                />
              </>
            )}
            rightActions={(
              <>
                <VoiceInputButton voiceInput={composer.voiceInput} message={composer.message} disabled={isDisabled} />
                <ComposerActionButton
                  isActive={false}
                  isWaitingBackground={false}
                  canSubmit={composer.canSubmit}
                  isSending={createSession.isPending || composer.isUploading}
                  isInterrupting={false}
                  onInterrupt={NOOP}
                />
              </>
            )}
            footer={(
              <>
                <VoiceInputError error={composer.voiceInput.error} onDismiss={composer.voiceInput.clearError} className="mt-2" />
                <UploadError error={composer.uploadError} onDismiss={composer.clearUploadError} className="mt-2" />
                <AgentRuntimeErrorView error={createSession.error} className="mt-2" />
              </>
            )}
          />
        </form>
        <div className="flex items-center justify-end gap-1 px-6 py-3 text-xs text-muted-foreground">
          <kbd className="inline-flex items-center justify-center rounded-sm bg-muted border border-border/50 px-1 h-4 text-xs font-sans leading-none">↵</kbd>
          <span>Send</span>
          <span className="mx-1">·</span>
          <kbd className="inline-flex items-center justify-center rounded-sm bg-muted border border-border/50 px-1 h-4 text-xs font-sans leading-none">⇧↵</kbd>
          <span>New line</span>
        </div>
      </div>
    </div>
  )
}
