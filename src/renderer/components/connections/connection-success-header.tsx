import { ServiceIcon } from '@renderer/components/ui/service-icon'

interface ConnectionSuccessHeaderProps {
  toolkit: string
  displayName: string
}

export function ConnectionSuccessHeader({ toolkit, displayName }: ConnectionSuccessHeaderProps) {
  return (
    <div className="flex flex-col items-center gap-2 py-2">
      <div className="h-12 w-12 rounded-full bg-green-100 dark:bg-green-900/50 flex items-center justify-center">
        <ServiceIcon slug={toolkit} fallback="oauth" className="h-6 w-6 text-green-600 dark:text-green-400" />
      </div>
      <div className="text-center">
        <p className="text-base font-medium capitalize">
          {displayName} Successfully Connected!
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Configure what agents can do with this account.
        </p>
      </div>
    </div>
  )
}
