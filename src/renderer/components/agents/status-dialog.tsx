import * as React from 'react'
import { Halftone } from '@renderer/components/agents/halftone'
import {
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { cn } from '@shared/lib/utils/cn'

/**
 * Shared treatment for the blocking status dialogs (template install,
 * onboarding setup): the backdrop slowly fades up to blurred, faintly tinted
 * glass while the panel rises from below and fades in simultaneously — no
 * zoom. The slow pacing is entrance-only; exits run at the default dialog
 * speed (the overlay holds Radix's modal input lock until its animation ends,
 * so a slow exit would swallow clicks after dismissal), but keep the same
 * vertical-slide shape via the exit vars.
 *
 * Everything animation-related is inline style, not classes, because classes
 * lose here twice over: tailwind-merge can't resolve conflicts between
 * tailwindcss-animate utilities (the base DialogContent already sets
 * zoom-in-95 / slide-in-from-top-[48%]), and duration-* / ease-[…] resolve to
 * the core transition utilities instead of animation pacing (measured:
 * animation-duration stayed at the 150ms default). Inline wins
 * deterministically, and switching the style object on `open` is what scopes
 * the pacing to the entrance.
 */
const slideVars = {
  '--tw-enter-scale': '1',
  '--tw-enter-translate-x': '-50%',
  '--tw-enter-translate-y': 'calc(-50% + 3rem)',
  '--tw-exit-scale': '1',
  '--tw-exit-translate-x': '-50%',
  '--tw-exit-translate-y': 'calc(-50% + 3rem)',
} as React.CSSProperties

function contentStyle(open: boolean): React.CSSProperties {
  return open
    ? {
        ...slideVars,
        animationDuration: '525ms',
        animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
      }
    : slideVars
}

function overlayStyle(open: boolean): React.CSSProperties | undefined {
  return open
    ? { animationDuration: '750ms', animationTimingFunction: 'ease-out' }
    : undefined
}

interface StatusDialogContentProps
  extends Omit<React.ComponentPropsWithoutRef<typeof DialogContent>, 'style'> {
  /** The Dialog root's open state — scopes the slow animation pacing to the entrance. */
  open: boolean
}

/**
 * The status dialogs' shared frame: one 512×288 card, content vertically
 * centered, dot-matrix backdrop, soft entrance. `overflow-y-auto` (the content
 * never scrolls) keeps the base dialog's permanent scrollbar track off the
 * rounded corners, and `outline-none` keeps the browser focus ring off the
 * panel, which Radix focuses directly when there are no focusable children.
 */
export function StatusDialogContent({ open, className, children, ...props }: StatusDialogContentProps) {
  return (
    <DialogContent
      className={cn('max-w-lg min-h-72 content-center overflow-y-auto outline-none', className)}
      style={contentStyle(open)}
      overlayClassName="bg-black/5 backdrop-blur-sm"
      overlayStyle={overlayStyle(open)}
      {...props}
    >
      <StatusDialogMatrix />
      {children}
    </DialogContent>
  )
}

/** Centered header. sm:text-center beats the base header's sm:text-left so
    multi-line descriptions (e.g. error messages) stay centered at all widths. */
export function StatusDialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <DialogHeader className={cn('items-center text-center sm:text-center', className)} {...props} />
}

export function StatusDialogTitle({
  shimmer = true,
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogTitle> & {
  /** Turn off the sweeping-band animation (e.g. for error states). */
  shimmer?: boolean
}) {
  return (
    <DialogTitle
      className={cn('text-base font-normal', shimmer && 'status-title-shimmer', className)}
      {...props}
    />
  )
}

/**
 * The agent cards' dot-matrix, as a quiet backdrop for the status dialogs.
 * Idle-state flow keeps it slow and dim; the renderer's built-in cursor
 * influence gives the dots a gentle mouse reaction. Negative z-index paints it
 * above the dialog's background but under its text (DialogContent is a
 * stacking context via its fixed z-50).
 */
function StatusDialogMatrix() {
  return (
    <div className="absolute inset-0 -z-10 text-muted-foreground/50" aria-hidden>
      <Halftone
        motif="flow_3d"
        state="idle"
        spacing={6}
        maxRadius={1.3}
        vignette={0.5}
        contrast={1.2}
        seed={7}
      />
      {/* Soft background-colored smudge over the center so the dots never
          fight the text for contrast. Radial gradient rather than a blurred
          element — same look, no filter cost. */}
      <div className="absolute inset-0 [background:radial-gradient(55%_45%_at_50%_50%,hsl(var(--background))_35%,transparent_80%)]" />
    </div>
  )
}
