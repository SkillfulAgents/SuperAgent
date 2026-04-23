import { useCallback, useRef, useState } from 'react'
import { Phone, Upload, FileArchive, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { OptionCard } from '@renderer/components/ui/option-card'
import { Input } from '@renderer/components/ui/input'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { VoiceAgent } from '@renderer/components/ui/voice-agent'
import { SkillInstallDialog } from '@renderer/components/agents/skill-install-dialog'
import { apiFetch } from '@renderer/lib/api'
import { useDeleteAgent } from '@renderer/hooks/use-agents'
import { useImportAgentTemplate, type ImportProgress } from '@renderer/hooks/use-agent-templates'
import { useIsVoiceAgentConfigured } from '@renderer/hooks/use-voice-input'
import type { VoiceAgentConfig } from '@renderer/lib/voice-agent'
import type { ApiAgent } from '@shared/lib/types/api'

export interface ImportResult {
  agent: ApiAgent
  hasOnboarding?: boolean
}

export interface AgentCreationAidsProps {
  /** Called after the voice agent interview completes with its tool-call args. */
  onVoiceResult: (args: { name: string; prompt: string }) => void
  /** Called after a successful import (post-env-var prompt if any). */
  onImportComplete: (result: ImportResult) => void | Promise<void>
  /** Optional className forwarded to the cards wrapper. */
  className?: string
}

/**
 * Voice-agent-for-ideas + Import cards that originally lived inside the
 * Create New Agent modal. Now used as creation aids on an agent's empty
 * home state. Callers decide what to do with the voice result / imported
 * agent — this component is pure UI + dialog plumbing.
 */
export function AgentCreationAids({ onVoiceResult, onImportComplete, className }: AgentCreationAidsProps) {
  const hasVoiceConfigured = useIsVoiceAgentConfigured()
  const deleteAgent = useDeleteAgent()

  // --- Voice agent flow ---
  const [showVoiceAgent, setShowVoiceAgent] = useState(false)
  const [voiceAgentConfig, setVoiceAgentConfig] = useState<VoiceAgentConfig | null>(null)

  const startVoiceAgent = useCallback(async () => {
    try {
      const res = await apiFetch('/api/stt/voice-agent-prompt?name=create-agent')
      if (!res.ok) throw new Error('Failed to load voice agent prompt')
      const { prompt } = (await res.json()) as { prompt: string }
      setVoiceAgentConfig({
        systemPrompt: prompt,
        tools: [
          {
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
          },
        ],
      })
      setShowVoiceAgent(true)
    } catch (error) {
      console.error('Failed to start Voice Agent:', error)
    }
  }, [])

  const handleVoiceAgentResult = useCallback(
    (_name: string, argsJson: string) => {
      try {
        const args = JSON.parse(argsJson) as { name: string; prompt: string }
        setShowVoiceAgent(false)
        setVoiceAgentConfig(null)
        onVoiceResult(args)
      } catch (error) {
        console.error('Failed to process Voice Agent result:', error)
      }
    },
    [onVoiceResult],
  )

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
    agent: ApiAgent
    requiredEnvVars: Array<{ name: string; description: string }>
    hasOnboarding?: boolean
  } | null>(null)

  const acceptFile = useCallback((file: File | null | undefined) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast.error('Only .zip template files are supported')
      return
    }
    setImportFile(file)
  }, [])

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

  const finishImport = useCallback(
    async (agent: ApiAgent, hasOnboarding?: boolean) => {
      await onImportComplete({ agent, hasOnboarding })
    },
    [onImportComplete],
  )

  const handleImport = useCallback(
    async (e: React.FormEvent) => {
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
            agent: result,
            requiredEnvVars: result.requiredEnvVars,
            hasOnboarding: result.hasOnboarding,
          })
          return
        }

        setShowImportDialog(false)
        resetImport()
        await finishImport(result, result.hasOnboarding)
      } catch (error) {
        setUploadProgress(null)
        console.error('Failed to import template:', error)
      }
    },
    [importFile, importName, importFull, importTemplate, resetImport, finishImport],
  )

  const handleTemplateSecretsSubmit = useCallback(
    async (envVars: Record<string, string>) => {
      if (!templateSecretsPrompt) return
      const { agent, hasOnboarding } = templateSecretsPrompt
      setTemplateSecretsPrompt(null)

      for (const [key, value] of Object.entries(envVars)) {
        if (value && typeof value === 'string') {
          try {
            await apiFetch(`/api/agents/${encodeURIComponent(agent.slug)}/secrets`, {
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
      await finishImport(agent, hasOnboarding)
    },
    [templateSecretsPrompt, resetImport, finishImport],
  )

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault()
    acceptFile(e.dataTransfer.files[0])
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-4 pt-2 px-6 mb-4">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">OR</span>
        <div className="h-px flex-1 bg-border" />
      </div>
      <div className="space-y-4">
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

      <Dialog open={showVoiceAgent} onOpenChange={(open) => { if (!open) closeVoiceAgent() }}>
        <DialogContent className="max-w-2xl p-0 overflow-hidden h-[420px]">
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
                    acceptFile(e.target.files?.[0])
                    e.target.value = ''
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
                  id="creation-aids-import-full"
                  checked={importFull}
                  onCheckedChange={(checked) => setImportFull(checked === true)}
                  disabled={importTemplate.isPending}
                />
                <label
                  htmlFor="creation-aids-import-full"
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
              deleteAgent.mutate(templateSecretsPrompt.agent.slug)
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

