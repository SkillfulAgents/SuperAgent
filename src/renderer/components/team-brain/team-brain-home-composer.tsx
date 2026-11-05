import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowUp, Loader2 } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { UploadError } from '@renderer/components/ui/upload-error'
import { ChatComposerBox, FLOATING_COMPOSER_CLASS } from '@renderer/components/messages/chat-composer-box'
import { ComposerOptions } from '@renderer/components/messages/composer-options'
import { AgentDefaultFooter } from '@renderer/components/messages/agent-default-footer'
import { AgentRuntimeErrorView } from '@shared/lib/agent-runtime-errors/agent-runtime-error-view'
import { useNewSessionComposer } from '@renderer/hooks/use-new-session-composer'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import type { ReferenceAttachment } from '@renderer/components/messages/attachment-preview'

/** The card's exit (its `duration-200` in attachment-preview.tsx), and a frame to land. A timer, as reduced motion plays none. */
const CARD_EXIT_MS = 200 + 50

/**
 * Agent Home's composer on Team Brain's home page, for its agent: ask it
 * something or tell it what to keep. Sending starts a session with the Team
 * Brain agent and opens it. The same box, attachments, model picker and
 * dictation as Agent Home, in the session composer's glass (it floats over
 * the tree); Agent Home's voice-mode and expand buttons are left out.
 */
export function TeamBrainHomeComposer({ agent, reference, onDismissReference }: {
  agent: ApiAgent
  /** What is in focus on the page: sent with the message unless ✕ sets it aside. */
  reference?: ReferenceAttachment | null
  onDismissReference?: () => void
}) {
  const navigate = useNavigate()
  const { data: runtimeStatus, isPending: isRuntimePending } = useRuntimeStatus()
  const isRuntimeReady = isRuntimePending || runtimeStatus?.runtimeReadiness?.status === 'READY'

  const { composer, composerOptions, createSession, isDisabled } = useNewSessionComposer({
    agentSlug: agent.slug,
    draftKey: `team-brain:${agent.slug}`,
    references: reference ? [reference] : undefined,
    submitDisabled: !isRuntimeReady,
    agentRuntimeErrorsShownInline: true,
    onSessionCreated: ({ session }) => {
      void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: agent.displaySlug ?? agent.slug, sessionId: session.id } })
    },
  })

  // One card at a time: what is in focus, or for its exit's length once nothing is, the one that was.
  const [last, setLast] = useState(reference ?? null)
  if (reference && reference.id !== last?.id) setLast(reference)
  const referenceId = reference?.id
  useEffect(() => {
    if (referenceId || !last) return
    const done = setTimeout(() => setLast(null), CARD_EXIT_MS)
    return () => clearTimeout(done)
  }, [referenceId, last])
  const card = reference ?? (last && { ...last, leaving: true })

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (composer.canSubmit) void composer.handleSubmit(event)
    }
  }

  return (
    <>
      <MountChoiceDialog
        open={composer.mountDialog.open}
        onChoice={composer.mountDialog.onChoice}
        folderName={composer.mountDialog.folderName}
      />
      {composer.chipDialog}
      <form
        onSubmit={composer.handleSubmit}
        className={cn('mx-auto w-full max-w-[720px]', composer.isDragOver && 'rounded-2xl ring-2 ring-inset ring-primary')}
        data-testid="team-brain-composer"
        {...composer.dragHandlers}
      >
        <ChatComposerBox
          attachments={card ? [card, ...composer.attachments] : composer.attachments}
          onRemoveAttachment={(id) => (id === reference?.id ? onDismissReference?.() : composer.removeAttachment(id))}
          onRetryAttachment={composer.retryAttachment}
          value={composer.message}
          onChange={composer.setMessage}
          onKeyDown={handleKeyDown}
          onPaste={composer.handlePaste}
          placeholder="Ask Team Brain anything, or tell it something to keep…"
          disabled={isDisabled}
          rows={2}
          dataTestId="team-brain-message-input"
          // The session's glass, more see-through: here the tree, not a thread, is behind it.
          className={cn(FLOATING_COMPOSER_CLASS, 'bg-background/70 supports-[backdrop-filter]:bg-background/45')}
          secureSecrets={{
            agentSlug: agent.slug,
            potentialSecrets: composer.potentialSecrets,
            onDismiss: composer.dismissPotentialSecret,
            onSecure: composer.securePotentialSecret,
          }}
          chipContext={composer.chipContext}
          textareaClassName="min-h-[60px] max-h-[120px]"
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
                footer={<AgentDefaultFooter agentSlug={agent.slug} state={composerOptions} agentHomeLink={false} />}
              />
            </>
          )}
          rightActions={(
            <>
              <VoiceInputButton voiceInput={composer.voiceInput} message={composer.message} disabled={isDisabled} />
              <Button
                type="submit"
                size="icon"
                className="h-[34px] w-[34px]"
                disabled={!composer.canSubmit}
                data-testid="team-brain-send-button"
                aria-label="Send message"
              >
                {isDisabled ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
              </Button>
            </>
          )}
          footer={(
            <>
              <VoiceInputError error={composer.voiceInput.error} onDismiss={composer.voiceInput.clearError} className="mt-2 justify-center" />
              <UploadError error={composer.uploadError} onDismiss={composer.clearUploadError} className="mt-2 justify-center" />
              <AgentRuntimeErrorView error={createSession.error} className="mt-2" />
            </>
          )}
        />
      </form>
    </>
  )
}
