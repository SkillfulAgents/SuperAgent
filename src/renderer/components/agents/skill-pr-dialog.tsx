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
import { Loader2, ExternalLink, AlertTriangle } from 'lucide-react'
import { useSkillPRInfo, useCreateSkillPR } from '@renderer/hooks/use-agent-skills'

interface SkillPRDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentSlug: string
  skillDir: string
}

export function SkillPRDialog({
  open,
  onOpenChange,
  agentSlug,
  skillDir,
}: SkillPRDialogProps) {
  const { data: prInfo, isLoading: isLoadingInfo, error: infoError } = useSkillPRInfo(
    open ? agentSlug : null,
    open ? skillDir : null,
  )
  const createPR = useCreateSkillPR()

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [newVersion, setNewVersion] = useState('')
  const [prUrl, setPrUrl] = useState<string | null>(null)

  // Populate fields when AI suggestions arrive
  useEffect(() => {
    if (prInfo) {
      setTitle(prInfo.suggestedTitle)
      setBody(prInfo.suggestedBody)
      setNewVersion(prInfo.suggestedVersion)
    }
  }, [prInfo])

  // Reset when dialog closes
  useEffect(() => {
    if (!open) {
      setTitle('')
      setBody('')
      setNewVersion('')
      setPrUrl(null)
      createPR.reset()
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !body.trim()) return

    try {
      const result = await createPR.mutateAsync({
        agentSlug,
        skillDir,
        title: title.trim(),
        body: body.trim(),
        newVersion: newVersion.trim() || undefined,
      })
      setPrUrl(result.prUrl)
    } catch {
      // Error is handled by createPR.error
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Open Pull Request</DialogTitle>
            <DialogDescription>
              Submit your local changes back to the skillset repository.
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
                    {infoError instanceof Error ? infoError.message : 'Failed to load PR info'}
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="pr-title">PR Title</Label>
                <div className="relative">
                  <Input
                    id="pr-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Update skill..."
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
                <Label htmlFor="pr-body">Description</Label>
                <div className="relative">
                  <Textarea
                    id="pr-body"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="Describe your changes..."
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
                <Label htmlFor="pr-version">New Version</Label>
                <div className="relative">
                  <Input
                    id="pr-version"
                    value={newVersion}
                    onChange={(e) => setNewVersion(e.target.value)}
                    placeholder="e.g. 1.1.0"
                    disabled={!!infoError}
                  />
                  {isLoadingInfo && !newVersion && (
                    <div className="absolute right-3 top-0 bottom-0 flex items-center">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Updates the version in the skill&apos;s metadata. Leave as-is to keep the current version.
                </p>
              </div>

              {createPR.error && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{createPR.error.message}</AlertDescription>
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
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!title.trim() || !body.trim() || isLoadingInfo || !!infoError || createPR.isPending}
                >
                  {createPR.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Creating PR...
                    </>
                  ) : (
                    'Create Pull Request'
                  )}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
