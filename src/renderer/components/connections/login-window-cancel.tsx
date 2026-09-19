import { Button } from '@renderer/components/ui/button'

interface LoginWindowCancelProps {
  visible: boolean
  onCancel: () => void
  testId?: string
}

export function LoginWindowCancel({ visible, onCancel, testId }: LoginWindowCancelProps) {
  if (!visible) return null

  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto px-0 py-0 text-[11px] font-normal text-muted-foreground hover:text-foreground"
      onClick={(event) => {
        event.stopPropagation()
        onCancel()
      }}
      data-testid={testId}
      aria-label="Cancel sign-in"
    >
      Cancel
    </Button>
  )
}
