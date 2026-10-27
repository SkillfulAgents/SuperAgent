import type { ReactNode } from 'react'
import { Brain, X } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'

// The look of Figma's Dev Mode welcome modal (UI Inspo, node 57:3), in this
// app's tokens: brand blue where Figma uses its green.
const BUTTON_BASE =
  'inline-flex h-7 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'
export const PRIMARY = cn(BUTTON_BASE, 'bg-brand font-medium text-white hover:bg-brand/90')
export const SECONDARY = cn(BUTTON_BASE, 'border bg-background hover:bg-muted')

/**
 * Team Brain's modals (setting it up, connecting to it), laid out like Figma's
 * Dev Mode welcome: a dark rail with the brain glyph, the title and the
 * numbered steps, the current one in a filled pill; the step on the right,
 * with a close button in its corner. `testId` names the modal, `${testId}-step`
 * its right panel.
 */
export function TeamBrainModal({
  open,
  title,
  steps,
  current,
  onClose,
  close,
  testId,
  children,
}: {
  open: boolean
  /** The rail's title, a line each. */
  title: readonly string[]
  steps: readonly { id: string; label: string }[]
  current: string
  /** Asked to close: by Escape, a click outside or the close button. */
  onClose: () => void
  close: { label: string; testId: string }
  testId: string
  children: ReactNode
}) {
  const index = Math.max(steps.findIndex((step) => step.id === current), 0)
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        hideClose
        className="flex h-[min(600px,calc(100vh-2rem))] w-[min(900px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden border-0 p-0 shadow-2xl sm:rounded-2xl"
        data-testid={testId}
        aria-describedby={`${testId}-step`}
      >
        <aside className="flex w-[300px] shrink-0 flex-col justify-between bg-[#1e1e1e] pb-5 pt-11 text-white max-sm:hidden dark:bg-black">
          <div className="px-9">
            <Brain className="size-8" strokeWidth={1.5} aria-hidden="true" />
            <DialogTitle className="mt-6 text-[33px]/[1.2] font-normal tracking-[-0.01em]">
              {title.map((line) => (
                <span key={line} className="block">{line}</span>
              ))}
            </DialogTitle>
          </div>
          <ol className="space-y-0.5 px-5" aria-label="Steps">
            {steps.map((step, i) => (
              <li
                key={step.id}
                aria-current={i === index ? 'step' : undefined}
                className={cn(
                  'flex h-11 items-center gap-4 rounded-md px-3.5 text-[14px] text-white transition-colors',
                  i === index && 'bg-brand',
                )}
              >
                <span className={cn('min-w-[26px] text-[19px]/none font-light tabular-nums', i !== index && 'text-white/40')}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="min-w-0 flex-1 truncate">{step.label}</span>
              </li>
            ))}
          </ol>
        </aside>

        <section className="relative flex min-w-0 flex-1 flex-col bg-background" data-testid={`${testId}-step`} data-step={steps[index]?.id}>
          <DialogDescription id={`${testId}-step`} className="sr-only">
            Step {index + 1} of {steps.length}: {steps[index]?.label}
          </DialogDescription>
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 top-3 z-10 grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={close.label}
            data-testid={close.testId}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
          {children}
        </section>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The right panel for one step: title and subtitle, the step's content
 * centred in the space beneath them (scrolling when it's long), and the ruled
 * footer with its buttons.
 */
export function StepPanel({
  title,
  subtitle,
  children,
  back,
  next,
}: {
  title: string
  subtitle: ReactNode
  children: ReactNode
  back?: () => void
  next?: { label: ReactNode; onClick: () => void; disabled?: boolean; testId?: string }
}) {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-8 pt-11 sm:px-[52px]">
        <h2 className="pr-8 text-[18px] font-medium tracking-[-0.005em]">{title}</h2>
        <p className="mt-2 text-[13px] text-muted-foreground">{subtitle}</p>
        {/* Short content sits midway down the space left under the subtitle; long content just scrolls. */}
        <div className="my-auto pt-7">{children}</div>
      </div>
      <footer className="flex h-[60px] shrink-0 items-center justify-end gap-2 border-t px-[18px]">
        {back && (
          <button type="button" className={SECONDARY} onClick={back} data-testid="team-brain-back">
            Back
          </button>
        )}
        {next && (
          <button type="button" className={PRIMARY} onClick={next.onClick} disabled={next.disabled} data-testid={next.testId ?? 'team-brain-next'}>
            {next.label}
          </button>
        )}
      </footer>
    </>
  )
}
