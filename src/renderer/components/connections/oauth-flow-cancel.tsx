import { Button } from '@renderer/components/ui/button'
import { cn } from '@shared/lib/utils/cn'

interface OAuthFlowCancelProps {
  visible: boolean
  onCancel: () => void
  className?: string
  testId?: string
}

export function OAuthFlowCancel({ visible, onCancel, className, testId }: OAuthFlowCancelProps) {
  if (!visible) return null

  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className={cn(
        'h-auto px-0 py-0 text-[11px] font-normal text-muted-foreground hover:text-foreground',
        className,
      )}
      onClick={(event) => {
        event.stopPropagation()
        onCancel()
      }}
      data-testid={testId}
    >
      Cancel
    </Button>
  )
}
