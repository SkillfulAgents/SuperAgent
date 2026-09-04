import { Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader } from '@renderer/components/ui/card'

export type WorkspaceUnavailableOverlayMode = 'asleep' | 'updating'

/** Waking: cover red errors until reload hits the ingress page. Sleeping: click to wake. */
export function WorkspaceUnavailableOverlay({ mode }: { mode: WorkspaceUnavailableOverlayMode }) {
  const asleep = mode === 'asleep'
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background"
      data-testid={asleep ? 'workspace-asleep-overlay' : 'workspace-updating-overlay'}
    >
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <h2 className="text-lg font-medium">
            {asleep ? 'Your workspace is asleep' : 'Updating your workspace'}
          </h2>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          {asleep ? (
            <>
              <p className="text-sm text-muted-foreground">
                It powered down while idle. Wake it up to keep working — this will reload the page.
              </p>
              <Button
                className="w-full"
                data-testid="workspace-asleep-reload"
                onClick={() => window.location.reload()}
              >
                Wake it up
              </Button>
            </>
          ) : (
            <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Getting it ready again…
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}