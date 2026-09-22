import { useState, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { Label } from '@renderer/components/ui/label'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { ArrowRight, ArrowUpFromLine, Check, Loader2, ExternalLink, AlertTriangle, ChevronLeft } from 'lucide-react'
import { useAgentTemplatePublishInfo, usePublishAgentTemplate } from '@renderer/hooks/use-agent-templates'
import { useSkillsets } from '@renderer/hooks/use-skillsets'
import { isSkillsetPublishable } from '@renderer/lib/skillset-publish-ui'
import { cn } from '@shared/lib/utils'

interface AgentTemplatePublishPanelProps {
  agentSlug: string
  /** Return to the Publish tab's entry view. */
  onBack: () => void
}

/**
 * Inline publish flow for the agent share popover's Publish tab:
 * title/description/version form first, then choosing a skillset as the final,
 * committing step — clicking a writable skillset selects it. State resets by
 * unmounting when the user navigates back.
 */
export function AgentTemplatePublishPanel({ agentSlug, onBack }: AgentTemplatePublishPanelProps) {
  const [step, setStep] = useState<'form' | 'pick'>('form')
  const { data: skillsets } = useSkillsets()

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [newVersion, setNewVersion] = useState('')
  const [selectedSkillsetId, setSelectedSkillsetId] = useState<string | null>(null)
  const [publishResult, setPublishResult] = useState<{ prUrl?: string; successMessage: string } | null>(null)

  // Selection defaults to the first writable skillset, mirroring the Export
  // tab's preselected radio pattern. Read-only skillsets stay listed.
  const firstWritableId = skillsets?.find((ss) => isSkillsetPublishable(ss.publishMode))?.id ?? null
  const selectedId = selectedSkillsetId ?? firstWritableId

  // Suggested title/body/version derive from the agent's CLAUDE.md (see
  // getAgentPublishInfo); the fetch targets the currently selected skillset so
  // its publish preconditions are checked before the final Publish click.
  const {
    data: publishInfo,
    isLoading: isLoadingInfo,
    error: infoError,
  } = useAgentTemplatePublishInfo(agentSlug, selectedId)
  const publishAgent = usePublishAgentTemplate()

  // The suggestions arrive async (an LLM call server-side) — only prefill
  // fields the user hasn't filled themselves, and only while the form is
  // still on screen, so typed values are never silently replaced.
  useEffect(() => {
    if (!publishInfo || step !== 'form') return
    setTitle((prev) => prev || publishInfo.suggestedTitle)
    setBody((prev) => prev || publishInfo.suggestedBody)
    setNewVersion((prev) => prev || publishInfo.suggestedVersion)
  }, [publishInfo, step])

  const handleBack = () => {
    if (step === 'pick' && !publishResult) {
      setStep('form')
      publishAgent.reset()
    } else {
      onBack()
    }
  }

  const handlePublish = async () => {
    if (publishAgent.isPending || !selectedId) return
    try {
      const result = await publishAgent.mutateAsync({
        agentSlug,
        skillsetId: selectedId,
        title: title.trim(),
        body: body.trim(),
        newVersion: newVersion.trim() || undefined,
      })
      setPublishResult(result)
    } catch {
      // Error is handled by publishAgent.error
    }
  }

  return (
    <div data-testid="agent-publish-flow">
      {/* Back navigation — takes the place of the popover's tab bar */}
      <div className="flex items-center gap-1 border-b px-3 py-2">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0"
          onClick={handleBack}
          aria-label="Back"
          data-testid="publish-flow-back"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <p className="text-sm font-medium">
          {publishResult ? 'Published' : step === 'form' ? 'Publish details' : 'Choose a skillset'}
        </p>
      </div>

      <div className="p-3">
      {publishResult ? (
        <div className="space-y-3">
          <Alert>
            <AlertDescription>{publishResult.successMessage}</AlertDescription>
          </Alert>
          {publishResult.prUrl && (
            <a
              href={publishResult.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-primary hover:underline"
            >
              <ExternalLink className="h-4 w-4 shrink-0" />
              <span className="truncate">{publishResult.prUrl}</span>
            </a>
          )}
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={onBack}>
              Done
            </Button>
          </div>
        </div>
      ) : step === 'form' ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (title.trim() && body.trim()) setStep('pick')
          }}
        >
          {/* Suggestion fetch failure (e.g. the skillset's publish
              preconditions fail) — the form stays usable; the skillset picker
              and final Publish surface their own errors. */}
          {infoError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{infoError.message}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="agent-publish-title">Title</Label>
            <div className="relative">
              <Input
                id="agent-publish-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Add new agent template..."
              />
              {isLoadingInfo && !title && (
                <div className="absolute bottom-0 right-3 top-0 flex items-center">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-publish-body">Description</Label>
            <div className="relative">
              <Textarea
                id="agent-publish-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Describe this agent template..."
                className="min-h-[80px] resize-none"
              />
              {isLoadingInfo && !body && (
                <div className="absolute right-3 top-3">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-publish-version">Version</Label>
            <div className="relative">
              <Input
                id="agent-publish-version"
                value={newVersion}
                onChange={(e) => setNewVersion(e.target.value)}
                placeholder="e.g. 1.0.0"
              />
              {isLoadingInfo && !newVersion && (
                <div className="absolute bottom-0 right-3 top-0 flex items-center">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              className="gap-1"
              disabled={!title.trim() || !body.trim()}
              data-testid="publish-flow-submit"
            >
              Next
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </form>
      ) : !skillsets || skillsets.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No skillsets configured. Add a skillset in Settings first.
        </p>
      ) : (
        <div className="space-y-3">
          <div role="radiogroup" aria-label="Skillset" className="-mx-2 space-y-1">
            {skillsets.map((ss) => {
              const publishable = isSkillsetPublishable(ss.publishMode)
              const isSelected = selectedId === ss.id
              return (
                <button
                  key={ss.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  disabled={!publishable}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left',
                    publishable ? 'hover:bg-accent' : 'cursor-not-allowed opacity-70',
                  )}
                  onClick={() => setSelectedSkillsetId(ss.id)}
                  data-testid={`publish-skillset-option-${ss.id}`}
                >
                  <span className="min-w-0 flex-1">
                    <p className="text-[11px]">
                      {ss.name}
                      {!publishable && (
                        <span className="ml-1.5 font-medium text-muted-foreground">Read only</span>
                      )}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                      {ss.description}
                    </p>
                  </span>
                  {isSelected ? (
                    <Check className="h-4 w-4 shrink-0" />
                  ) : (
                    <span className="h-4 w-4 shrink-0" />
                  )}
                </button>
              )
            })}
          </div>
          <Button
            className="w-full gap-1.5"
            onClick={() => void handlePublish()}
            disabled={!selectedId}
            data-testid="publish-flow-publish"
          >
            {publishAgent.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <ArrowUpFromLine className="h-4 w-4" />
                Publish
              </>
            )}
          </Button>
          {(publishAgent.error || infoError) && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {(publishAgent.error ?? infoError)?.message}
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
      </div>
    </div>
  )
}
