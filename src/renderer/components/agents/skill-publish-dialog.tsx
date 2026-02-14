import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { Label } from '@renderer/components/ui/label'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Loader2, ExternalLink, AlertTriangle, ChevronLeft } from 'lucide-react'
import { useSkillPublishInfo, usePublishSkill } from '@renderer/hooks/use-agent-skills'
import { useSkillsets } from '@renderer/hooks/use-skillsets'
import type { ApiSkillsetConfig } from '@shared/lib/types/api'

interface SkillPublishDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentSlug: string
  skillDir: string
}

export function SkillPublishDialog({
  open,
  onOpenChange,
  agentSlug,
  skillDir,
}: SkillPublishDialogProps) {
  const [step, setStep] = useState<'pick' | 'form'>('pick')
  const [selectedSkillset, setSelectedSkillset] = useState<ApiSkillsetConfig | null>(null)
  const { data: skillsets } = useSkillsets()

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [newVersion, setNewVersion] = useState('')
  const [prUrl, setPrUrl] = useState<string | null>(null)

  const { data: publishInfo, isLoading: isLoadingInfo, error: infoError } = useSkillPublishInfo(
    step === 'form' ? agentSlug : null,
    step === 'form' ? skillDir : null,
    step === 'form' ? selectedSkillset?.id ?? null : null,
  )
  const publishSkill = usePublishSkill()

  // Populate fields when AI suggestions arrive
  useEffect(() => {
    if (publishInfo) {
      setTitle(publishInfo.suggestedTitle)
      setBody(publishInfo.suggestedBody)
      setNewVersion(publishInfo.suggestedVersion)
    }
  }, [publishInfo])

  // Reset when dialog closes
  useEffect(() => {
    if (!open) {
      setStep('pick')
      setSelectedSkillset(null)
      setTitle('')
      setBody('')
      setNewVersion('')
      setPrUrl(null)
      publishSkill.reset()
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSkillsetSelect = (ss: ApiSkillsetConfig) => {
    setSelectedSkillset(ss)
    setStep('form')
  }

  const handleBack = () => {
    setStep('pick')
    setSelectedSkillset(null)
    setTitle('')
    setBody('')
    setNewVersion('')
    publishSkill.reset()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !body.trim() || !selectedSkillset) return

    try {
      const result = await publishSkill.mutateAsync({
        agentSlug,
        skillDir,
        skillsetId: selectedSkillset.id,
        title: title.trim(),
        body: body.trim(),
        newVersion: newVersion.trim() || undefined,
      })
      setPrUrl(result.prUrl)
    } catch {
      // Error is handled by publishSkill.error
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {step === 'pick' ? (
          <>
            <DialogHeader>
              <DialogTitle>Publish Skill</DialogTitle>
              <DialogDescription>
                Choose a skillset to publish this skill to.
              </DialogDescription>
            </DialogHeader>

            <div className="py-4">
              {!skillsets || skillsets.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No skillsets configured. Add a skillset in Settings first.
                </p>
              ) : (
                <div className="space-y-2">
                  {skillsets.map((ss) => (
                    <button
                      key={ss.id}
                      type="button"
                      className="w-full text-left p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                      onClick={() => handleSkillsetSelect(ss)}
                    >
                      <p className="text-sm font-medium">{ss.name}</p>
                      <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                        {ss.description}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Publish Skill</DialogTitle>
              <DialogDescription>
                Submit this skill to the {selectedSkillset?.name} skillset via a pull request.
              </DialogDescription>
            </DialogHeader>

            {prUrl ? (
              <div className="py-6 space-y-3">
                <Alert>
                  <AlertDescription>
                    Pull request created successfully.
                  </AlertDescription>
                </Alert>
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-primary hover:underline"
                >
                  <ExternalLink className="h-4 w-4" />
                  {prUrl}
                </a>
              </div>
            ) : (
              <div className="py-4 space-y-4">
                {infoError && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      {infoError instanceof Error ? infoError.message : 'Failed to load publish info'}
                    </AlertDescription>
                  </Alert>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="publish-title">PR Title</Label>
                  <div className="relative">
                    <Input
                      id="publish-title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Add new skill..."
                      disabled={!!infoError}
                    />
                    {isLoadingInfo && !title && (
                      <div className="absolute right-3 top-0 bottom-0 flex items-center">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="publish-body">Description</Label>
                  <div className="relative">
                    <Textarea
                      id="publish-body"
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      placeholder="Describe this skill..."
                      className="min-h-[100px] resize-none"
                      disabled={!!infoError}
                    />
                    {isLoadingInfo && !body && (
                      <div className="absolute right-3 top-3">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="publish-version">Version</Label>
                  <div className="relative">
                    <Input
                      id="publish-version"
                      value={newVersion}
                      onChange={(e) => setNewVersion(e.target.value)}
                      placeholder="e.g. 1.0.0"
                      disabled={!!infoError}
                    />
                    {isLoadingInfo && !newVersion && (
                      <div className="absolute right-3 top-0 bottom-0 flex items-center">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </div>
                </div>

                {publishSkill.error && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>{publishSkill.error.message}</AlertDescription>
                  </Alert>
                )}
              </div>
            )}

            <DialogFooter>
              {prUrl ? (
                <Button type="button" onClick={() => onOpenChange(false)}>
                  Done
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleBack}
                    className="mr-auto"
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Back
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onOpenChange(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={!title.trim() || !body.trim() || isLoadingInfo || !!infoError || publishSkill.isPending}
                  >
                    {publishSkill.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Publishing...
                      </>
                    ) : (
                      'Create Pull Request'
                    )}
                  </Button>
                </>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
