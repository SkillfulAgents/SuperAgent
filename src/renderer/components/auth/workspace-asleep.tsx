import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader } from '@renderer/components/ui/card'

/**
 * Full-window overlay shown when ingress reports the workspace asleep or
 * errored. Rendered OVER the app (which stays mounted) so nothing typed is
 * lost; the reload is the user's call and lands on the click-to-wake page.
 */
export function WorkspaceAsleepOverlay() {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
      data-testid="workspace-asleep-overlay"
    >
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <h2 className="text-lg font-medium">Your workspace is asleep</h2>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
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
        </CardContent>
      </Card>
    </div>
  )
}
