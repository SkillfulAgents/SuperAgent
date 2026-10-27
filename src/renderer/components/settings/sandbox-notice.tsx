import { Info } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'

/**
 * What the Mac App Store edition leaves out, in the words of the features
 * people know, so its Settings says so up front instead of each one being
 * missing against what the website describes. One line per capability the
 * sandbox withholds (`facts/capabilities.ts`, `renderer/lib/capabilities.ts`);
 * the agents' prompt keeps its own list (`appSandbox`).
 */
export const SANDBOX_LEAVES_OUT = [
  'Computer use, and agents running scripts on this Mac',
  'Browsing in your own Chrome, with its profiles and Apple Passwords. Agents browse in their built-in browser.',
  'Folders on this Mac as drives',
  'Private GitHub skillsets, and publishing skills and agents to GitHub',
  'Container runtimes other than the built-in one',
  'Keep Awake, Add to Dock, recent files in the attachment menu, and pausing your music in voice mode',
]

export function SandboxNotice() {
  return (
    // A note, not an alert: nothing went wrong, and it should not interrupt a screen reader.
    <Alert role="note" data-testid="sandbox-notice">
      <Info className="h-4 w-4" />
      <AlertTitle>Mac App Store edition</AlertTitle>
      <AlertDescription className="text-muted-foreground">
        <p>macOS runs App Store apps in a sandbox, so this edition leaves out what reaches outside the app:</p>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          {SANDBOX_LEAVES_OUT.map((feature) => <li key={feature}>{feature}</li>)}
        </ul>
      </AlertDescription>
    </Alert>
  )
}
