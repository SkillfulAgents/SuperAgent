import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { copyTextToClipboard } from '@renderer/lib/clipboard'
import { cn } from '@shared/lib/utils/cn'

/**
 * The shared shell for subscription setup in the connection editor (Claude
 * setup-token, Grok/Codex device sign-in): a muted panel with an optional
 * intro, badge-numbered steps, and small caveat notes under a divider.
 */
export function SetupPanel({ title, children, notes, className, ...rest }: {
  /** Shown above the panel in the form's field-label style. */
  title?: string
  children: ReactNode
  notes?: ReactNode[]
  className?: string
  'data-testid'?: string
}) {
  const shownNotes = notes?.filter(Boolean) ?? []
  const panel = (
    <div className={cn('rounded-lg bg-muted p-4 text-sm space-y-4', className)} {...(title ? {} : rest)}>
      {children}
      {shownNotes.length > 0 && (
        <ul className="space-y-1 border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
          {shownNotes.map((note, index) => <li key={index}>{note}</li>)}
        </ul>
      )}
    </div>
  )
  if (!title) return panel
  return (
    <section className="grid gap-2 text-sm" aria-label={title} {...rest}>
      <h3>{title}</h3>
      {panel}
    </section>
  )
}

export function SetupSteps({ steps }: { steps: ReactNode[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((step, index) => (
        <li key={index} className="flex gap-3">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-background text-[11px] font-medium text-muted-foreground">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 flex flex-col">{step}</span>
        </li>
      ))}
    </ol>
  )
}

/** A command or code in a box with a copy button that briefly turns into a check. */
export function CopyableValue({ value, label, large = false }: { value: string; label: string; large?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    copyTextToClipboard(value)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => toast.error('Could not copy. Select and copy it manually.'))
  }
  return (
    <span className="mt-2 flex items-center justify-between gap-2 rounded-md border bg-background py-1.5 pl-3 pr-1.5">
      <code className={cn('select-all font-mono', large ? 'text-base font-medium tracking-widest' : 'text-xs')}>{value}</code>
      <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={copied ? 'Copied' : label} title={label} onClick={copy}>
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </span>
  )
}
