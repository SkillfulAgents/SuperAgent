import { useState, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { Label } from '@renderer/components/ui/label'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { ArrowRight, ArrowUpFromLine, Check, Loader2, ExternalLink, AlertTriangle, ChevronLeft } from 'lucide-react'
import { useAgentTemplatePublishInfo, usePublishAgentTemplate } from '@renderer/hooks/use-agent-templates'
import { useSkillsets } from '@renderer/hooks/use-skillsets'

interface AgentTemplatePublishPanelProps {
  agentSlug: string
  /** Return to the Publish tab's entry view. */
  onBack: () => void
}

/**
 * Inline publish flow for the agent share popover's Publish tab:
 * title/description/version form first, then choosing a library as the final,
 * committing step — clicking a library publishes to it. State resets by
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

  // Suggested title/body/version derive from the agent's CLAUDE.md, not the
  // target library (see getAgentPublishInfo), so prefill via the first
  // configured library even though the user picks the real target last.
  const firstSkillsetId = skillsets?.[0]?.id ?? null
  const { data: publishInfo, isLoading: isLoadingInfo } = useAgentTemplatePublishInfo(
    agentSlug,
    firstSkillsetId,
  )
  const publishAgent = usePublishAgentTemplate()

  useEffect(() => {
    if (publishInfo) {
      setTitle(publishInfo.suggestedTitle)
      setBody(publishInfo.suggestedBody)
      setNewVersion(publishInfo.suggestedVersion)
    }
  }, [publishInfo])

  const handleBack = () => {
    if (step === 'pick' && !publishResult) {
      setStep('form')
      publishAgent.reset()
    } else {
      onBack()
    }
  }

  // Selection defaults to the first library, mirroring the Export tab's
  // preselected radio pattern.
  const selectedId = selectedSkillsetId ?? firstSkillsetId

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
          {publishResult ? 'Published' : step === 'form' ? 'Publish details' : 'Choose a library'}
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
          No libraries connected. Add one in Settings first.
        </p>
      ) : (
        <div className="space-y-3">
          <div role="radiogroup" aria-label="Library" className="-mx-2 space-y-1">
            {skillsets.map((ss) => {
              const isSelected = selectedId === ss.id
              return (
                <button
                  key={ss.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent"
                  onClick={() => setSelectedSkillsetId(ss.id)}
                  data-testid={`publish-skillset-option-${ss.id}`}
                >
                  <span className="min-w-0 flex-1">
                    <p className="text-sm">{ss.name}</p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
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
          {publishAgent.error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{publishAgent.error.message}</AlertDescription>
            </Alert>
          )}
        </div>
      )}
      </div>
    </div>
  )
}
