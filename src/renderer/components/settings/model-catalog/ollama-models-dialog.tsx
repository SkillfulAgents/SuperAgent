import { useState, type FormEvent } from 'react'
import { Check, Download, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Progress } from '@renderer/components/ui/progress'
import { useModelDownloads, useServerStatus, type ModelServerTarget } from '@renderer/hooks/use-model-server'
import { OLLAMA_LIBRARY_URL, ollamaModelNameSchema } from '@shared/lib/llm-provider/ollama-schema'
import type { InstalledModel, ModelDownload } from '@shared/lib/llm-provider/server-status-schema'
import { ExternalAnchor } from '../ollama-setup-panel'

const SECTION_HEADING = 'px-1 pb-1 text-[11px] font-medium text-muted-foreground'
const ROW = 'flex items-center gap-3 rounded-item px-2 py-1.5'

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.round(bytes / 1e3)} KB`
}

/** Ollama's implicit tag, so `qwen3.8` and `qwen3.8:latest` compare as one model. */
const withTag = (name: string) => (name.includes(':') ? name : `${name}:latest`)

const UNUSABLE_REASON: Record<NonNullable<InstalledModel['unusableReason']>, string> = {
  'no-tools': 'Can\'t run agents: no tool support',
  'embedding-only': 'Embedding model: can\'t run agents',
}

/** Without `onCancel`, the viewer may watch the download but not stop it. */
function PullRow({ pull, onCancel }: { pull: ModelDownload; onCancel?: () => void }) {
  const failed = pull.state === 'failed'
  const percent = pull.totalBytes ? (pull.completedBytes / pull.totalBytes) * 100 : 0
  return (
    <div className={ROW} data-testid={`ollama-pull-${pull.model}`}>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-xs font-medium">{pull.model}</span>
          {!failed && (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {pull.totalBytes
                ? `${formatBytes(pull.completedBytes)} of ${formatBytes(pull.totalBytes)} · ${Math.floor(percent)}%`
                : pull.phase}
            </span>
          )}
        </div>
        {failed
          ? <div role="alert" className="text-[11px] text-destructive">{pull.error ?? 'The download failed'}</div>
          : <Progress percent={percent} role="progressbar" aria-label={`Downloading ${pull.model}`} aria-valuenow={Math.floor(percent)} aria-valuemin={0} aria-valuemax={100} />}
      </div>
      {onCancel && (
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={failed ? `Dismiss ${pull.model}` : `Cancel downloading ${pull.model}`} onClick={onCancel}>
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}

/**
 * Downloaded models, and a download by name from ollama.com's library. Pulls
 * run on the server, so closing this leaves them going and reopening picks them back up.
 */
export function OllamaModelsDialog({ open, onOpenChange, target, canDownload }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: ModelServerTarget
  canDownload: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <OllamaModelsBody target={target} canDownload={canDownload} />}
    </Dialog>
  )
}

function OllamaModelsBody({ target, canDownload }: { target: ModelServerTarget; canDownload: boolean }) {
  const [name, setName] = useState('')
  const status = useServerStatus(target)
  const { downloads: pulls, start, cancel } = useModelDownloads(target)

  const installed = status.data?.state === 'running' ? status.data.models : []
  const parsed = ollamaModelNameSchema.safeParse(name)
  const model = parsed.success ? parsed.data : undefined
  const alreadyInstalled = model !== undefined && installed.some(entry => entry.id === withTag(model))
  const busy = model !== undefined && pulls.some(pull => pull.model === model && pull.state === 'running')
  // Said only once something is typed: an empty box is not a mistake.
  const problem = !name.trim() ? undefined : parsed.success ? (alreadyInstalled ? 'Already downloaded' : undefined) : parsed.error.issues[0]?.message

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!model || alreadyInstalled || busy) return
    start.mutate(model, { onSuccess: () => setName('') })
  }

  return (
    <DialogContent className="sm:max-w-xl" data-testid="ollama-models-dialog">
      <DialogHeader>
        <DialogTitle>Ollama models</DialogTitle>
        <DialogDescription>
          Downloaded models join this connection&apos;s catalog automatically. Downloads keep going if you close this.
        </DialogDescription>
      </DialogHeader>
      {canDownload && (
        <form onSubmit={submit} className="space-y-1.5">
          <div className="flex gap-2">
            <Input
              aria-label="Model name"
              aria-invalid={!parsed.success && !!name.trim()}
              data-testid="ollama-model-name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Model name, such as qwen3.8:27b"
              className="h-8 text-xs"
            />
            <Button type="submit" size="sm" className="h-8" disabled={!model || alreadyInstalled || busy} data-testid="ollama-pull-submit">
              <Download className="h-3.5 w-3.5" />
              Download
            </Button>
          </div>
          {problem && <p role="alert" className="px-1 text-[11px] text-muted-foreground">{problem}</p>}
          {start.isError && <p role="alert" className="px-1 text-[11px] text-destructive">{start.error.message}</p>}
        </form>
      )}
      <p className="px-1 text-[11px] text-muted-foreground">
        <ExternalAnchor href={OLLAMA_LIBRARY_URL}>Browse models on ollama.com</ExternalAnchor>
        {canDownload ? ' and copy a name from there. Agents need one that supports tools.' : '. Only an admin can download models.'}
      </p>
      <div className="max-h-[26rem] space-y-4 overflow-y-auto">
        {pulls.length > 0 && (
          <section aria-label="Downloads">
            <h3 className={SECTION_HEADING}>Downloads</h3>
            {pulls.map(pull => <PullRow key={pull.model} pull={pull} onCancel={canDownload ? () => cancel.mutate(pull.model) : undefined} />)}
          </section>
        )}
        <section aria-label="Downloaded">
          <h3 className={SECTION_HEADING}>Downloaded</h3>
          {installed.length === 0 && <p className="px-1 py-1 text-[11px] text-muted-foreground">No models downloaded yet.</p>}
          {installed.map(entry => (
            <div key={entry.id} className={ROW} data-testid={`ollama-installed-${entry.id}`}>
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{entry.label}</div>
                {entry.unusableReason && <div className="text-[11px] text-muted-foreground">{UNUSABLE_REASON[entry.unusableReason]}</div>}
              </div>
              {entry.sizeBytes && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{formatBytes(entry.sizeBytes)}</span>}
            </div>
          ))}
        </section>
      </div>
    </DialogContent>
  )
}
