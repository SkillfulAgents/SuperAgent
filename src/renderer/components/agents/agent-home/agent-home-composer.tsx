import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { ArrowUp, Loader2, Maximize2, Minimize2 } from 'lucide-react'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { VoiceModeButton } from '@renderer/components/ui/voice-mode-button'
import { readAloud } from '@renderer/lib/voice/services/read-aloud'
import { VOICE_MODE_ENTERED_MESSAGE } from '@shared/lib/voice/voice-mode-messages'
import { UploadError } from '@renderer/components/ui/upload-error'
import { AgentRuntimeErrorView } from '@shared/lib/agent-runtime-errors/agent-runtime-error-view'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { useNewSessionComposer } from '@renderer/hooks/use-new-session-composer'
import { ChatComposerBox } from '@renderer/components/messages/chat-composer-box'
import { registerSessionComposerFocus } from '@renderer/components/messages/composer-focus'
import { useIsMobile } from '@renderer/hooks/use-mobile'
import { ComposerOptions } from '@renderer/components/messages/composer-options'
import { AgentDefaultFooter } from '@renderer/components/messages/agent-default-footer'
import { HOME_GLASS_COMPOSER_CLASS } from './home-glass-panel'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import {
  useTypewriterPlaceholder,
  DEFAULT_AGENT_PROMPT_EXAMPLES,
  DISABLED as TYPEWRITER_DISABLED,
} from '@renderer/hooks/use-typewriter-placeholder'
import { useRenameUntitledAgent } from '@renderer/hooks/use-rename-untitled-agent'
import { useWarmStartOnType } from '@renderer/hooks/use-warm-start-on-type'
import { useWarmStartOnTypeEnabled } from '@renderer/hooks/use-settings'
import { useRenderTracker } from '@renderer/lib/perf'
import { agentHomeDraftKey, agentHomeId } from '@renderer/context/drafts-context'

/** What the rest of Agent Home asks of its composer, without holding any of its state. */
export interface AgentHomeComposerHandle {
  /** Put a skill's slash command in the composer, bring it into view and focus it. */
  runSkill: (skillPath: string) => void
  /** Open a session in voice mode; the composer button and the empty-state card both land here. */
  startVoiceSession: (origin: 'home' | 'home_card') => Promise<void>
  /** Tell warm start that the next change to the message is not the user typing. */
  noteProgrammaticChange: (prompt: string) => void
}

interface AgentHomeComposerProps {
  agent: ApiAgent
  /** An untitled agent with no sessions yet: the typewriter placeholder and the "Create Agent" button. */
  isFreshUntitled: boolean
  isRuntimeReady: boolean
  onSessionCreated: (sessionId: string, initialMessage: string, messageUuid: string, options?: { voiceMode?: boolean }) => void
}

/**
 * Agent Home's composer, as its own component so that what changes while someone types (the message, the typewriter
 * placeholder's 40-80 ticks a second, warm start, the expanded state, an upload or a create in flight) re-renders this
 * and not the page around it: the side panel, the sessions, the title row, the backdrop.
 */
export const AgentHomeComposer = forwardRef<AgentHomeComposerHandle, AgentHomeComposerProps>(function AgentHomeComposer(
  { agent, isFreshUntitled, isRuntimeReady, onSessionCreated },
  ref,
) {
  useRenderTracker('AgentHomeComposer')
  const [isExpanded, setIsExpanded] = useState(false)
  const composerTextareaRef = useRef<HTMLDivElement>(null)
  // The file drawer's Submit adds comments to this composer's draft and focuses it here.
  useEffect(() => registerSessionComposerFocus(agentHomeId(agent.slug), () => composerTextareaRef.current?.focus()), [agent.slug])
  const isMobile = useIsMobile()
  const { track } = useAnalyticsTracking()
  // Tracks an explicit user collapse so the auto-expand effect doesn't fight it.
  // Reset when the message clears (e.g. after submit).
  const userCollapsedRef = useRef(false)
  const renameUntitledAgent = useRenameUntitledAgent()

  const { composer, composerOptions, createSession, isDisabled } = useNewSessionComposer({
    agentSlug: agent.slug,
    // The agent's home draft: the file drawer adds comments to it, and a stale session's "start fresh" moves its own here.
    draftKey: agentHomeDraftKey(agent.slug),
    // The default-model card sits next to this composer; untouched selections track its edits.
    followDefaults: true,
    submitDisabled: !isRuntimeReady,
    agentRuntimeErrorsShownInline: true,
    onSessionCreated: ({ session, content }) => {
      // Preserve the server's message identity for the optimistic pending copy.
      onSessionCreated(session.id, content, session.initialMessageUuid)
      // This mutation survives navigation because its query client is app-scoped.
      if (isFreshUntitled) {
        renameUntitledAgent.mutate({ slug: agent.slug, prompt: content })
      }
    },
  })

  const warmStartEnabled = useWarmStartOnTypeEnabled()
  const { noteProgrammaticChange } = useWarmStartOnType({
    agentSlug: agent.slug,
    message: composer.message,
    enabled: warmStartEnabled,
  })

  // Reset the manual-collapse flag once the message clears.
  useEffect(() => {
    if (composer.message.trim() === '') userCollapsedRef.current = false
  }, [composer.message])

  // Auto-flip to expanded when the textarea content overflows its max-height
  // (CSS-driven 6-line cap). field-sizing handles the actual sizing — this only
  // decides whether to switch into the full-view layout.
  useEffect(() => {
    const el = composerTextareaRef.current
    if (!el || isExpanded || userCollapsedRef.current) return
    if (el.scrollHeight > el.clientHeight) {
      setIsExpanded(true)
    }
  }, [composer.message, isExpanded])

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (!composer.canSubmit) return
      void composer.handleSubmit(e)
    }
  }

  // Voice mode from the home page: the session opens with the voice-mode
  // notice as its first message, and its composer comes up listening. The
  // composer button and the empty-state "Brainstorm with Voice" card both land here.
  const startVoiceSession = useCallback(async (origin: 'home' | 'home_card') => {
    if (isDisabled) return
    // Audio output is unlocked here, inside the click, for the reply to use.
    readAloud.unlockAudio()
    try {
      const runtimeOptions = composerOptions.toRuntimeOptions()
      const session = await createSession.mutateAsync({
        agentSlug: agent.slug,
        message: VOICE_MODE_ENTERED_MESSAGE,
        inputMode: 'voice',
        ...runtimeOptions,
      })
      composerOptions.markSubmitted(runtimeOptions)
      onSessionCreated(session.id, VOICE_MODE_ENTERED_MESSAGE, session.initialMessageUuid, { voiceMode: true })
      track('voice_mode_entered', { origin })
    } catch (error) {
      console.error('Failed to start a voice session:', error)
      readAloud.releaseUnlockedAudio()
      track('voice_mode_start_failed', { origin })
    }
  }, [isDisabled, createSession, agent.slug, composerOptions, onSessionCreated, track])

  // The page's other cards reach the composer through this handle. It is rebuilt on every render here and read only
  // when one of them is used, so they always get this render's composer without the page re-rendering for it.
  useImperativeHandle(ref, () => ({
    runSkill: (skillPath) => {
      composer.setMessage(`/${skillPath} `)
      composerTextareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setTimeout(() => composerTextareaRef.current?.focus(), 0)
    },
    startVoiceSession,
    noteProgrammaticChange,
  }))

  const typewriterPlaceholder = useTypewriterPlaceholder(
    isFreshUntitled ? DEFAULT_AGENT_PROMPT_EXAMPLES : TYPEWRITER_DISABLED,
  )
  const composerPlaceholder = isFreshUntitled
    ? typewriterPlaceholder
    : 'How can I help? Press cmd+enter to send'

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
        className={cn('intro-step intro-step-2', composer.isDragOver && 'rounded-dialog ring-2 ring-primary ring-inset')}
        {...composer.dragHandlers}
      >
        <ChatComposerBox
          // The session composer's glass with the panels' glass edge: the sessions pass under it once it docks.
          className={HOME_GLASS_COMPOSER_CLASS}
          textareaRef={composerTextareaRef}
          attachments={composer.attachments}
          onRemoveAttachment={composer.removeAttachment}
          onRetryAttachment={composer.retryAttachment}
          value={composer.message}
          onChange={composer.setMessage}
          onKeyDown={handleKeyDown}
          onPaste={composer.handlePaste}
          placeholder={composerPlaceholder}
          disabled={isDisabled}
          rows={2}
          autoFocus={!isMobile}
          dataTestId="home-message-input"
          secureSecrets={{
            agentSlug: agent.slug,
            potentialSecrets: composer.potentialSecrets,
            onDismiss: composer.dismissPotentialSecret,
            onSecure: composer.securePotentialSecret,
          }}
          chipContext={composer.chipContext}
          textareaClassName={`transition-[min-height] duration-300 ease-in-out ${isExpanded ? 'min-h-[50vh] max-h-[50vh]' : 'min-h-[40px] max-h-[120px]'}`}
          leftActions={(
            <>
              <AttachmentPicker
                buttonClassName="h-7 w-7 shrink-0 p-0"
                onFileSelect={composer.handleFileSelect}
                onFolderSelect={composer.handleFolderSelect}
                onRecentFileAttach={(file) => composer.addFiles([{ file }])}
                disabled={isDisabled}
              />
              <ComposerOptions
                state={composerOptions}
                disabled={isDisabled}
                size="sm"
                footer={
                  <AgentDefaultFooter
                    agentSlug={agent.slug}
                    state={composerOptions}
                    agentHomeLink={false}
                  />
                }
              />
            </>
          )}
          topRightActions={(
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-muted-foreground/50 hover:text-foreground"
              onClick={() => setIsExpanded((v) => {
                // If user is collapsing, remember it so the auto-expand
                // effect doesn't immediately re-flip a still-overflowing message.
                userCollapsedRef.current = v
                return !v
              })}
              aria-label={isExpanded ? 'Shrink input' : 'Expand input'}
            >
              {isExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
          )}
          rightActions={(
            <>
              <VoiceInputButton voiceInput={composer.voiceInput} message={composer.message} disabled={isDisabled} size="compact" />
              {!isFreshUntitled && (
                <VoiceModeButton onClick={() => void startVoiceSession('home')} disabled={isDisabled} className="h-7 w-7" />
              )}
              {isFreshUntitled ? (
                <Button
                  type="submit"
                  size="sm"
                  className="ml-1.5 h-7"
                  disabled={!composer.canSubmit}
                  data-testid="home-send-button"
                >
                  {isDisabled ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    'Create Agent'
                  )}
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  // 6px before it: the plain buttons' own 6px padding is the rest of the gap (chat-composer-box.tsx).
                  className="ml-1.5 h-7 w-7"
                  disabled={!composer.canSubmit}
                  data-testid="home-send-button"
                  aria-label="Send message"
                >
                  {isDisabled ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowUp className="h-4 w-4" />
                  )}
                </Button>
              )}
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
})
