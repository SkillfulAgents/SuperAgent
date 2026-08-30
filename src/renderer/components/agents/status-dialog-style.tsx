import type { CSSProperties } from 'react'
import { Halftone } from '@renderer/components/agents/halftone'

/**
 * Shared entrance treatment for the blocking status dialogs (template install,
 * onboarding setup): the backdrop slowly fades up to blurred, faintly tinted
 * glass while the panel rises from below and fades in simultaneously — no zoom.
 *
 * Everything animation-related is inline style, not classes, because classes
 * lose here twice over: tailwind-merge can't resolve conflicts between
 * tailwindcss-animate utilities (the base DialogContent already sets
 * zoom-in-95 / slide-in-from-top-[48%]), and duration-* / ease-[…] resolve to
 * the core transition utilities instead of animation pacing (measured:
 * animation-duration stayed at the 150ms default). Inline wins
 * deterministically. The pacing applies to exit as well — the expo curve
 * front-loads it, so closes still feel quick.
 */
export const statusDialogAnimation = {
  /** DialogContent style — slide-up-and-fade entrance, soft pacing. */
  contentStyle: {
    animationDuration: '525ms',
    animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
    '--tw-enter-scale': '1',
    '--tw-enter-translate-x': '-50%',
    '--tw-enter-translate-y': 'calc(-50% + 3rem)',
  } as CSSProperties,
  /** overlayClassName — frosted tint over the app. */
  overlay: 'bg-black/5 backdrop-blur-sm',
  /** Overlay style — the slow fade to blurred. */
  overlayStyle: {
    animationDuration: '750ms',
    animationTimingFunction: 'ease-out',
  } as CSSProperties,
}

/**
 * The agent cards' dot-matrix, as a quiet backdrop for the status dialogs.
 * Idle-state flow keeps it slow and dim; the renderer's built-in cursor
 * influence gives the dots a gentle mouse reaction. Negative z-index paints it
 * above the dialog's background but under its text (DialogContent is a
 * stacking context via its fixed z-50).
 */
export function StatusDialogMatrix() {
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
