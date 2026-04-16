import { useState, useCallback, useEffect, useRef } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { ChatComposerBox } from '@renderer/components/messages/chat-composer-box'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { VoiceAgent } from '@renderer/components/ui/voice-agent'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { SkillInstallDialog } from '@renderer/components/agents/skill-install-dialog'
import { useCreateAgent, useDeleteAgent } from '@renderer/hooks/use-agents'
import { useCreateSession } from '@renderer/hooks/use-sessions'
import { useImportAgentTemplate, type ImportProgress } from '@renderer/hooks/use-agent-templates'
import { useSelection } from '@renderer/context/selection-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import { useIsVoiceConfigured } from '@renderer/hooks/use-voice-input'
import { useUser } from '@renderer/context/user-context'
import { apiFetch } from '@renderer/lib/api'
import { FileArchive, Loader2, Phone, Upload } from 'lucide-react'
import type { VoiceAgentConfig } from '@renderer/lib/voice-agent'

const ONBOARDING_MESSAGE = 'This agent was just set up from a template. Please run the agent-onboarding skill to help me configure it.'

const PLACEHOLDER_EXAMPLES = [
  // HR recruiter — one-shot
  'Search LinkedIn for senior backend engineers in NYC with 5+ years of Python experience. Reach out to the top 10 candidates with personalized intro messages.',
  // CEO — recurring weekly
  'Every Monday morning, pull highlights from my Granola meetings, Linear issues, and Slack DMs. Send me a briefing of key decisions and blockers from last week.',
  // Financial ops — recurring monthly
  'At the end of every month, reconcile expenses from my Gmail receipts against our QuickBooks ledger. Flag anything missing, duplicated, or out of policy.',
  // Product manager — recurring daily
  'Every morning, scan new Linear issues and customer feedback from our support inbox. Cluster them into themes and post a daily summary in our #product Slack channel.',
]

interface CreateAgentStepProps {
  onAgentCreated?: () => Promise<void> | void
}

export function CreateAgentStep({ onAgentCreated }: CreateAgentStepProps) {
  const [pendingAgentSlug, setPendingAgentSlug] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Typewriter placeholder cycle
  const [displayedPlaceholder, setDisplayedPlaceholder] = useState('')
  useEffect(() => {
    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout>

    const TYPE_MS = 25
    const DELETE_MS = 12
    const HOLD_FULL_MS = 2000
    const HOLD_EMPTY_MS = 350

    const run = (exampleIdx: number, charIdx: number, deleting: boolean) => {
      if (cancelled) return
      const fullText = PLACEHOLDER_EXAMPLES[exampleIdx]

      if (!deleting && charIdx <= fullText.length) {
        setDisplayedPlaceholder(fullText.slice(0, charIdx))
        if (charIdx === fullText.length) {
          timeoutId = setTimeout(() => run(exampleIdx, charIdx, true), HOLD_FULL_MS)
        } else {
          timeoutId = setTimeout(() => run(exampleIdx, charIdx + 1, false), TYPE_MS)
        }
      } else if (deleting && charIdx >= 0) {
        setDisplayedPlaceholder(fullText.slice(0, charIdx))
        if (charIdx === 0) {
          timeoutId = setTimeout(
            () => run((exampleIdx + 1) % PLACEHOLDER_EXAMPLES.length, 0, false),
            HOLD_EMPTY_MS
          )
        } else {
          timeoutId = setTimeout(() => run(exampleIdx, charIdx - 1, true), DELETE_MS)
        }
      }
    }

    run(0, 0, false)

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [])
  const createAgent = useCreateAgent()
  const createSession = useCreateSession()
  const { selectAgent, selectSession } = useSelection()
  const { track } = useAnalyticsTracking()

  const composer = useMessageComposer({
    agentSlug: pendingAgentSlug ?? '',
    uploadFile: useCallback(async ({ file }: { file: File }) => {
      if (!pendingAgentSlug) throw new Error('No agent yet')
      const formData = new FormData()
      formData.append('file', file)
      const res = await apiFetch(
        `/api/agents/${pendingAgentSlug}/upload-file`,
        { method: 'POST', body: formData }
      )
      if (!res.ok) throw new Error('Failed to upload file')
      return res.json() as Promise<{ path: string }>
    }, [pendingAgentSlug]),
    uploadFolder: useCallback(async ({ sourcePath }: { sourcePath: string }) => {
      if (!pendingAgentSlug) throw new Error('No agent yet')
      const res = await apiFetch(
        `/api/agents/${pendingAgentSlug}/upload-folder`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourcePath }),
        }
      )
      if (!res.ok) throw new Error('Failed to upload folder')
      return res.json() as Promise<{ path: string }>
    }, [pendingAgentSlug]),
    onSubmit: useCallback(async (content: string) => {
      try {
        // Ask the backend to generate a descriptive name from the prompt using the summarizer model
        let generatedName = ''
        try {
          const res = await apiFetch('/api/agents/generate-name', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: content.trim() }),
          })
          if (res.ok) {
            const data = await res.json() as { name?: string }
            generatedName = data.name?.trim() ?? ''
          }
        } catch {
          // Fall back to simple truncation if the generate endpoint fails
        }
        const fallbackName = content.trim().split(/\s+/).slice(0, 5).join(' ').slice(0, 50)
        const agentName = generatedName || fallbackName || 'My First Agent'
        const newAgent = await createAgent.mutateAsync({ name: agentName })
        track('agent_created', { source: 'new', num_skills_added_at_creation: 0 })
        setPendingAgentSlug(newAgent.slug)
        selectAgent(newAgent.slug)

        const session = await createSession.mutateAsync({
          agentSlug: newAgent.slug,
          message: content,
        })
        selectSession(session.id)

        await onAgentCreated?.()
      } catch (error) {
        console.error('Failed to create agent:', error)
      }
    }, [createAgent, createSession, selectAgent, selectSession, track, onAgentCreated]),
  })

  // Auto-resize textarea based on content, capped at 240px
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`
    }
  }, [composer.message])

  // Voice Agent — "Start conversation" flow
  const hasVoiceConfigured = useIsVoiceConfigured()
  const { user } = useUser()
  const [showVoiceAgent, setShowVoiceAgent] = useState(false)
  const [voiceAgentConfig, setVoiceAgentConfig] = useState<VoiceAgentConfig | null>(null)

  const startVoiceAgent = useCallback(async () => {
    try {
      const res = await apiFetch('/api/stt/voice-agent-prompt?name=create-agent')
      if (!res.ok) throw new Error('Failed to load voice agent prompt')
      const { prompt } = await res.json() as { prompt: string }
      const firstName = user?.name?.split(' ')[0] || 'there'
      const personalizedPrompt = prompt.replaceAll('{{firstName}}', firstName)
      setVoiceAgentConfig({
        systemPrompt: personalizedPrompt,
        tools: [{
          name: 'submit_agent',
          description: 'Submit the agent name and system prompt after the interview is complete',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Short descriptive name for the agent (2-4 words)' },
              prompt: { type: 'string', description: 'Detailed system prompt for the agent' },
            },
            required: ['name', 'prompt'],
          },
        }],
      })
      setShowVoiceAgent(true)
    } catch (error) {
      console.error('Failed to start Voice Agent:', error)
    }
  }, [user?.name])

  const handleVoiceAgentResult = useCallback((_name: string, argsJson: string) => {
    try {
      const args = JSON.parse(argsJson) as { name: string; prompt: string }
      setShowVoiceAgent(false)
      setVoiceAgentConfig(null)
      if (args.prompt) {
        composer.setMessage(args.prompt)
        // Focus the textarea so the user can review/edit before submitting
        setTimeout(() => textareaRef.current?.focus(), 0)
      }
    } catch (error) {
      console.error('Failed to process Voice Agent result:', error)
    }
  }, [composer])

  const closeVoiceAgent = useCallback(() => {
    setShowVoiceAgent(false)
    setVoiceAgentConfig(null)
  }, [])

  // Import Agent flow
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importName, setImportName] = useState('')
  const [importFull, setImportFull] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<ImportProgress | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importTemplate = useImportAgentTemplate()
  const deleteAgent = useDeleteAgent()

  const [templateSecretsPrompt, setTemplateSecretsPrompt] = useState<{
    agentSlug: string
    requiredEnvVars: Array<{ name: string; description: string }>
    hasOnboarding?: boolean
  } | null>(null)

  const resetImport = useCallback(() => {
    setImportFile(null)
    setImportName('')
    setImportFull(false)
    setUploadProgress(null)
    importTemplate.reset()
  }, [importTemplate])

  const closeImportDialog = useCallback(() => {
    setShowImportDialog(false)
    resetImport()
  }, [resetImport])

  const finishImportedAgent = useCallback(async (slug: string, hasOnboarding?: boolean) => {
    track('agent_created', { source: 'import', num_skills_added_at_creation: 0 })
    selectAgent(slug)
    if (hasOnboarding) {
      try {
        const session = await createSession.mutateAsync({
          agentSlug: slug,
          message: ONBOARDING_MESSAGE,
        })
        selectSession(session.id)
      } catch {
        // Onboarding session creation failed — user can still use agent normally
      }
    }
    await onAgentCreated?.()
  }, [track, selectAgent, selectSession, createSession, onAgentCreated])

  const handleImport = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!importFile) return

    try {
      setUploadProgress({ phase: 'uploading', percent: 0 })
      const result = await importTemplate.mutateAsync({
        file: importFile,
        nameOverride: importName.trim() || undefined,
        mode: importFull ? 'full' : 'template',
        onProgress: setUploadProgress,
      })
      setUploadProgress(null)

      if (result.requiredEnvVars && result.requiredEnvVars.length > 0) {
        setTemplateSecretsPrompt({
          agentSlug: result.slug,
          requiredEnvVars: result.requiredEnvVars,
          hasOnboarding: result.hasOnboarding,
        })
        return
      }

      setShowImportDialog(false)
      resetImport()
      await finishImportedAgent(result.slug, result.hasOnboarding)
    } catch (error) {
      setUploadProgress(null)
      console.error('Failed to import template:', error)
    }
  }, [importFile, importName, importFull, importTemplate, resetImport, finishImportedAgent])

  const handleTemplateSecretsSubmit = useCallback(async (envVars: Record<string, string>) => {
    if (!templateSecretsPrompt) return
    const { agentSlug, hasOnboarding } = templateSecretsPrompt
    setTemplateSecretsPrompt(null)

    for (const [key, value] of Object.entries(envVars)) {
      if (value && typeof value === 'string') {
        try {
          await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/secrets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value }),
          })
        } catch (error) {
          console.error(`Failed to save secret ${key}:`, error)
        }
      }
    }

    setShowImportDialog(false)
    resetImport()
    await finishImportedAgent(agentSlug, hasOnboarding)
  }, [templateSecretsPrompt, resetImport, finishImportedAgent])

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file && file.name.endsWith('.zip')) {
      setImportFile(file)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      e.currentTarget.closest('form')?.requestSubmit()
    }
  }

  const isDisabled = createAgent.isPending || createSession.isPending

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-normal max-w-sm">Let&apos;s create your first agent</h2>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void composer.handleSubmit(e)
        }}
      >
        <ChatComposerBox
          textareaRef={textareaRef}
          attachments={composer.attachments}
          onRemoveAttachment={composer.removeAttachment}
          value={composer.message}
          onChange={(e) => composer.setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={composer.handlePaste}
          placeholder={displayedPlaceholder}
          disabled={isDisabled}
          rows={3}
          autoFocus
          dataTestId="wizard-agent-prompt"
          leftActions={(
            <AttachmentPicker
              onFileSelect={composer.handleFileSelect}
              onFolderSelect={composer.handleFolderSelect}
              disabled={isDisabled}
            />
          )}
          rightActions={(
            <>
              <VoiceInputButton voiceInput={composer.voiceInput} message={composer.message} disabled={isDisabled} />
              <Button
                type="submit"
                size="sm"
                data-testid="wizard-create-agent"
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
            </>
          )}
          footer={(
            <VoiceInputError error={composer.voiceInput.error} onDismiss={composer.voiceInput.clearError} className="mt-2 justify-center" />
          )}
        />
      </form>

      {/* OR divider */}
      <div className="flex items-center gap-4 pt-2 px-6">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">OR</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      {/* Alternative options — stacked cards */}
      <div className="space-y-4">
        {hasVoiceConfigured && (
          <OptionCard
            title="Try Talking to SuperAgent for Ideas."
            description={(
              <>
                Answer a few questions about your job — get a detailed<br />
                prompt for your first agent. Takes less than five minutes.
              </>
            )}
            icon={<Phone className="h-4 w-4" />}
            buttonLabel="Start talking"
            onClick={startVoiceAgent}
          />
        )}

        <OptionCard
          title="Import an agent or agent template."
          description={(
            <>
              Bring in a pre-built agent from a .zip template,<br />
              including skills and optional environment variables.
            </>
          )}
          icon={<Upload className="h-4 w-4" />}
          buttonLabel="Import agent"
          onClick={() => setShowImportDialog(true)}
        />
      </div>

      {/* Voice Agent Dialog */}
      <Dialog open={showVoiceAgent} onOpenChange={(open) => { if (!open) closeVoiceAgent() }}>
        <DialogContent className="max-w-2xl p-0 overflow-hidden">
          <DialogHeader className="sr-only">
            <DialogTitle>Let&apos;s talk about your first agent</DialogTitle>
            <DialogDescription>
              Answer a few quick questions and Superagent will draft a detailed prompt for you to review.
            </DialogDescription>
          </DialogHeader>
          {voiceAgentConfig && (
            <VoiceAgent
              config={voiceAgentConfig}
              onResult={handleVoiceAgentResult}
              onClose={closeVoiceAgent}
              layout="split"
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Import Agent Dialog */}
      <Dialog open={showImportDialog} onOpenChange={(open) => { if (!open) closeImportDialog() }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Import an agent</DialogTitle>
            <DialogDescription>
              Upload a .zip template to create a new agent.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleImport}>
            <div className="py-4 space-y-4">
              <div
                className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
                  importTemplate.isPending
                    ? 'opacity-50 pointer-events-none'
                    : 'cursor-pointer hover:bg-muted/50'
                }`}
                role="button"
                tabIndex={0}
                onClick={() => !importTemplate.isPending && fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !importTemplate.isPending) {
                    e.preventDefault()
                    fileInputRef.current?.click()
                  }
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={importTemplate.isPending ? undefined : handleFileDrop}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip"
                  className="hidden"
                  disabled={importTemplate.isPending}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) setImportFile(file)
                  }}
                />
                {importFile ? (
                  <div className="flex items-center justify-center gap-2">
                    <FileArchive className="h-5 w-5 text-primary" />
                    <span className="text-sm font-medium">{importFile.name}</span>
                    {!importTemplate.isPending && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs"
                        onClick={(e) => {
                          e.stopPropagation()
                          setImportFile(null)
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                ) : (
                  <>
                    <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                    <p className="text-sm text-muted-foreground">
                      Drop a .zip template file here or click to browse
                    </p>
                  </>
                )}
              </div>

              <Input
                placeholder="Name override (optional)"
                value={importName}
                onChange={(e) => setImportName(e.target.value)}
                disabled={importTemplate.isPending}
              />

              <div className="flex items-center gap-2">
                <Checkbox
                  id="wizard-import-full"
                  checked={importFull}
                  onCheckedChange={(checked) => setImportFull(checked === true)}
                  disabled={importTemplate.isPending}
                />
                <label
                  htmlFor="wizard-import-full"
                  className="text-sm text-muted-foreground cursor-pointer select-none"
                >
                  Full import (includes environment variables and data)
                </label>
              </div>

              {uploadProgress && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      {uploadProgress.phase === 'processing' && (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      )}
                      {uploadProgress.phase === 'uploading' ? 'Uploading...' : 'Processing...'}
                    </span>
                    {uploadProgress.phase === 'uploading' && (
                      <span>{Math.round(uploadProgress.percent)}%</span>
                    )}
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-300"
                      style={{
                        width: uploadProgress.phase === 'processing'
                          ? '100%'
                          : `${uploadProgress.percent}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {importTemplate.error && (
                <p className="text-sm text-destructive">{importTemplate.error.message}</p>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeImportDialog}
                disabled={importTemplate.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!importFile || importTemplate.isPending}>
                {importTemplate.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {uploadProgress?.phase === 'uploading' ? 'Uploading...' : 'Processing...'}
                  </>
                ) : (
                  'Import'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Secrets prompt for imported template */}
      {templateSecretsPrompt && (
        <SkillInstallDialog
          open={!!templateSecretsPrompt}
          onOpenChange={(open) => {
            if (!open) {
              // User cancelled — delete the already-created agent
              deleteAgent.mutate(templateSecretsPrompt.agentSlug)
              setTemplateSecretsPrompt(null)
            }
          }}
          skillName="agent template"
          requiredEnvVars={templateSecretsPrompt.requiredEnvVars}
          onInstall={handleTemplateSecretsSubmit}
        />
      )}
    </div>
  )
}

/** Stacked option card — low-emphasis by default, full opacity on hover. */
function OptionCard({
  title,
  description,
  icon,
  buttonLabel,
  onClick,
}: {
  title: string
  description: React.ReactNode
  icon: React.ReactNode
  buttonLabel: string
  onClick: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className="rounded-lg border p-5 flex items-center justify-between gap-4 cursor-pointer opacity-60 hover:opacity-100 hover:bg-muted/50 transition-all"
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        tabIndex={-1}
        className="gap-2 shrink-0 pointer-events-none"
      >
        {icon}
        {buttonLabel}
      </Button>
    </div>
  )
}
