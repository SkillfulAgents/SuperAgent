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
import {
  useDiscoverableAgents,
  useImportAgentTemplate,
  useInstallAgentFromSkillset,
  type ImportProgress,
} from '@renderer/hooks/use-agent-templates'
import { useSelection } from '@renderer/context/selection-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import { useIsVoiceAgentConfigured } from '@renderer/hooks/use-voice-input'
import { apiFetch } from '@renderer/lib/api'
import { ArrowLeft, Download, FileArchive, Loader2, Phone, Upload } from 'lucide-react'
import type { VoiceAgentConfig } from '@renderer/lib/voice-agent'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

const ONBOARDING_MESSAGE = 'This agent was just set up from a template. Please run the agent-onboarding skill to help me configure it.'

const PLACEHOLDER_EXAMPLES = [
  'Search LinkedIn for senior backend engineers in NYC with 5+ years of Python experience. Reach out to the top 10 candidates with personalized intro messages.',
  'Every Monday morning, pull highlights from my Granola meetings, Linear issues, and Slack DMs. Send me a briefing of key decisions and blockers from last week.',
  'At the end of every month, reconcile expenses from my Gmail receipts against our QuickBooks ledger. Flag anything missing, duplicated, or out of policy.',
  'Every morning, scan new Linear issues and customer feedback from our support inbox. Cluster them into themes and post a daily summary in our #product Slack channel.',
]

export interface CreateAgentFormProps {
  /** Fires after an agent is successfully created (via any path). Parent uses this to close the overlay/wizard. */
  onAgentCreated?: () => Promise<void> | void
  /** Pre-selects a template and jumps straight to the "name the agent" step. */
  initialTemplate?: ApiDiscoverableAgent | null
  /** Form max width in the layout. Defaults to no cap (wrapper decides). */
  className?: string
  /** When true, play the reverse (exit) animation on the same items. */
  exiting?: boolean
}

export function CreateAgentForm({ onAgentCreated, initialTemplate, className, exiting = false }: CreateAgentFormProps) {
  // Staggered reveal: items start hidden on first render, flip to visible on the next frame,
  // then flip back to hidden when `exiting` becomes true. Reverse the stagger on exit.
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setRevealed(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const itemHidden = exiting || !revealed
  const itemProps = (inDelayMs: number, outDelayMs: number) => ({
    className: 'create-agent-item',
    'data-hidden': itemHidden ? 'true' : 'false',
    style: { transitionDelay: `${exiting ? outDelayMs : inDelayMs}ms` },
  })
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
  const deleteAgent = useDeleteAgent()
  const { selectAgent, selectSession } = useSelection()
  const { track } = useAnalyticsTracking()
  const hasVoiceConfigured = useIsVoiceAgentConfigured()

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
        const agentName = generatedName || fallbackName || 'New Agent'
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

  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`
    }
  }, [composer.message])

  // --- Voice Agent flow ---
  const [showVoiceAgent, setShowVoiceAgent] = useState(false)
  const [voiceAgentConfig, setVoiceAgentConfig] = useState<VoiceAgentConfig | null>(null)

  const startVoiceAgent = useCallback(async () => {
    try {
      const res = await apiFetch('/api/stt/voice-agent-prompt?name=create-agent')
      if (!res.ok) throw new Error('Failed to load voice agent prompt')
      const { prompt } = await res.json() as { prompt: string }
      setVoiceAgentConfig({
        systemPrompt: prompt,
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
  }, [])

  const handleVoiceAgentResult = useCallback((_name: string, argsJson: string) => {
    try {
      const args = JSON.parse(argsJson) as { name: string; prompt: string }
      setShowVoiceAgent(false)
      setVoiceAgentConfig(null)
      if (args.prompt) {
        composer.setMessage(args.prompt)
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

  // --- Import flow ---
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importName, setImportName] = useState('')
  const [importFull, setImportFull] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<ImportProgress | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importTemplate = useImportAgentTemplate()

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

  const finishCreatedAgent = useCallback(async (slug: string, source: 'import' | 'skillset', hasOnboarding?: boolean) => {
    track('agent_created', { source, num_skills_added_at_creation: 0 })
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
      await finishCreatedAgent(result.slug, 'import', result.hasOnboarding)
    } catch (error) {
      setUploadProgress(null)
      console.error('Failed to import template:', error)
    }
  }, [importFile, importName, importFull, importTemplate, resetImport, finishCreatedAgent])

  const handleTemplateSecretsSubmit = useCallback(async (envVars: Record<string, string>) => {
    if (!templateSecretsPrompt) return
    const { agentSlug, hasOnboarding } = templateSecretsPrompt
    const source: 'import' | 'skillset' = showImportDialog ? 'import' : 'skillset'
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
    await finishCreatedAgent(agentSlug, source, hasOnboarding)
  }, [templateSecretsPrompt, showImportDialog, resetImport, finishCreatedAgent])

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

  // --- Template (From Skillset) flow ---
  const { data: discoverableAgents } = useDiscoverableAgents()
  const hasTemplates = !!(discoverableAgents && discoverableAgents.length > 0)
  const installFromSkillset = useInstallAgentFromSkillset()

  const [selectedTemplate, setSelectedTemplate] = useState<ApiDiscoverableAgent | null>(initialTemplate ?? null)
  const [templateAgentName, setTemplateAgentName] = useState(initialTemplate?.name ?? '')

  useEffect(() => {
    if (initialTemplate) {
      setSelectedTemplate(initialTemplate)
      setTemplateAgentName(initialTemplate.name)
    }
  }, [initialTemplate])

  const handleInstallFromSkillset = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedTemplate || !templateAgentName.trim()) return
    try {
      const newAgent = await installFromSkillset.mutateAsync({
        skillsetId: selectedTemplate.skillsetId,
        agentPath: selectedTemplate.path,
        agentName: templateAgentName.trim(),
        agentVersion: selectedTemplate.version,
      })

      if (newAgent.requiredEnvVars && newAgent.requiredEnvVars.length > 0) {
        setTemplateSecretsPrompt({
          agentSlug: newAgent.slug,
          requiredEnvVars: newAgent.requiredEnvVars,
          hasOnboarding: newAgent.hasOnboarding,
        })
        return
      }

      await finishCreatedAgent(newAgent.slug, 'skillset', newAgent.hasOnboarding)
    } catch (error) {
      console.error('Failed to install agent from skillset:', error)
    }
  }, [selectedTemplate, templateAgentName, installFromSkillset, finishCreatedAgent])

  const isDisabled = createAgent.isPending || createSession.isPending

  // When a template is selected (pre-install naming step), render that instead of the composer.
  if (selectedTemplate) {
    return (
      <div className={className}>
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => { setSelectedTemplate(null); setTemplateAgentName('') }}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>

          <form onSubmit={handleInstallFromSkillset} className="space-y-4">
            <div className="p-4 rounded-lg border bg-muted/30">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{selectedTemplate.name}</p>
                <span className="text-xs text-muted-foreground">v{selectedTemplate.version}</span>
              </div>
              {selectedTemplate.description && (
                <p className="text-sm text-muted-foreground mt-1">{selectedTemplate.description}</p>
              )}
              <p className="text-xs text-muted-foreground mt-2">from {selectedTemplate.skillsetName}</p>
            </div>

            <Input
              placeholder="Agent name"
              value={templateAgentName}
              onChange={(e) => setTemplateAgentName(e.target.value)}
              autoFocus
            />

            {installFromSkillset.error && (
              <p className="text-sm text-destructive">{installFromSkillset.error.message}</p>
            )}

            <div className="flex justify-end">
              <Button type="submit" disabled={!templateAgentName.trim() || installFromSkillset.isPending}>
                {installFromSkillset.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Installing...
                  </>
                ) : (
                  'Create agent'
                )}
              </Button>
            </div>
          </form>
        </div>

        {templateSecretsPrompt && (
          <SkillInstallDialog
            open={!!templateSecretsPrompt}
            onOpenChange={(open) => {
              if (!open) {
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

  return (
    <div className={className}>
      <div className="space-y-8">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void composer.handleSubmit(e)
          }}
          {...itemProps(80, 130)}
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
            dataTestId="create-agent-prompt"
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
                  data-testid="create-agent-submit"
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

        <div
          {...itemProps(160, 100)}
          className={`flex items-center gap-4 pt-2 px-6 ${itemProps(160, 100).className}`}
        >
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">OR</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <div
          {...itemProps(220, 70)}
          className={`space-y-4 ${itemProps(220, 70).className}`}
        >
          {hasVoiceConfigured && (
            <OptionCard
              title="Try Talking to SuperAgent for Ideas."
              description={(
                <>
                  Answer a few questions about your job — get a detailed<br />
                  prompt for your agent. Takes less than five minutes.
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

        {hasTemplates && (
          <>
            <div
              {...itemProps(300, 30)}
              className={`flex items-center gap-4 pt-2 px-6 ${itemProps(300, 30).className}`}
            >
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">OR START FROM A TEMPLATE</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <div
              {...itemProps(360, 0)}
              className={`space-y-4 ${itemProps(360, 0).className}`}
            >
              {groupBySkillset(discoverableAgents!).map(([skillsetName, agents]) => (
                <div key={skillsetName} className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground px-1">{skillsetName}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {agents.map((agent) => (
                      <button
                        key={`${agent.skillsetId}::${agent.path}`}
                        type="button"
                        onClick={() => {
                          setSelectedTemplate(agent)
                          setTemplateAgentName(agent.name)
                        }}
                        className="text-left rounded-lg border p-3 opacity-70 hover:opacity-100 focus-visible:opacity-100 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-all"
                      >
                        <div className="flex items-center gap-2">
                          <Download className="h-4 w-4 text-muted-foreground shrink-0" />
                          <p className="text-sm font-medium truncate">{agent.name}</p>
                          <span className="text-xs text-muted-foreground shrink-0">v{agent.version}</span>
                        </div>
                        {agent.description && (
                          <p className="text-xs text-muted-foreground line-clamp-2 mt-1">{agent.description}</p>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <Dialog open={showVoiceAgent} onOpenChange={(open) => { if (!open) closeVoiceAgent() }}>
        <DialogContent className="max-w-2xl p-0 overflow-hidden h-[420px] flex flex-col">
          <DialogHeader className="sr-only">
            <DialogTitle>Let&apos;s talk about your agent</DialogTitle>
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
                  id="create-agent-import-full"
                  checked={importFull}
                  onCheckedChange={(checked) => setImportFull(checked === true)}
                  disabled={importTemplate.isPending}
                />
                <label
                  htmlFor="create-agent-import-full"
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

      {templateSecretsPrompt && (
        <SkillInstallDialog
          open={!!templateSecretsPrompt}
          onOpenChange={(open) => {
            if (!open) {
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

function groupBySkillset(agents: ApiDiscoverableAgent[]): Array<[string, ApiDiscoverableAgent[]]> {
  const grouped = new Map<string, ApiDiscoverableAgent[]>()
  for (const agent of agents) {
    const existing = grouped.get(agent.skillsetName) || []
    existing.push(agent)
    grouped.set(agent.skillsetName, existing)
  }
  return Array.from(grouped.entries())
}

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
    <button
      type="button"
      onClick={onClick}
      aria-label={`${title} — ${buttonLabel}`}
      className="w-full text-left rounded-lg border p-5 flex items-center justify-between gap-4 cursor-pointer opacity-60 hover:opacity-100 focus-visible:opacity-100 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-all"
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <span className="inline-flex items-center gap-2 shrink-0 text-sm text-muted-foreground">
        {icon}
        {buttonLabel}
      </span>
    </button>
  )
}
