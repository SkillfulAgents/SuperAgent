import type { ComponentProps, ReactNode } from 'react'
import { AlertCircle, CheckCircle, Loader2 } from 'lucide-react'
import { DialogDescription, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'

/** Providers supply content; the setup frame and controls stay identical. */
export function IntegrationSetupLayout({ provider, label, iconClassName = '', instructions, children, feedback, actions }: {
  provider: string
  label: string
  iconClassName?: string
  instructions: ReactNode
  children: ReactNode
  feedback?: ReactNode
  actions: ReactNode
}) {
  return <>
    <DialogHeader>
      <DialogTitle className="flex items-center gap-2 font-normal">
        <ServiceIcon slug={provider} fallback="mcp" className={`h-5 w-5 ${iconClassName}`} />
        Set up integration with {label}
      </DialogTitle>
      <DialogDescription className="sr-only">Follow the instructions and connect this agent to {label}.</DialogDescription>
    </DialogHeader>
    <div className="flex flex-col md:flex-row gap-6 p-1 min-h-0 overflow-y-auto" data-testid="integration-setup-layout">
      <div className="md:w-[55%] min-w-0 flex flex-col justify-center gap-4 md:max-h-[60vh] md:overflow-y-auto">
        {instructions}
      </div>
      <div className="md:w-[45%] min-w-0 rounded-lg border bg-muted/40 shadow-md flex flex-col md:max-h-[60vh]">
        <div className="flex flex-col gap-4 overflow-y-auto p-4 flex-1 min-h-0">
          <div className="space-y-3">{children}</div>
          {feedback}
        </div>
        <div className="flex items-center justify-end gap-2 p-4">{actions}</div>
      </div>
    </div>
  </>
}

export function IntegrationSetupField({ label, optional, id, ...props }: ComponentProps<typeof Input> & { label: string; id: string; optional?: boolean }) {
  return <div>
    <Label htmlFor={id} className="text-xs font-normal">
      {label}{optional && <span className="ml-1 text-muted-foreground/70">optional</span>}
    </Label>
    <Input {...props} id={id} className="mt-1 shadow-none bg-background" />
  </div>
}

export function IntegrationSetupFeedback({ state, children }: { state: 'error' | 'success' | 'pending'; children: ReactNode }) {
  const Icon = state === 'error' ? AlertCircle : state === 'success' ? CheckCircle : Loader2
  const colors = state === 'error' ? 'border-red-200 bg-red-50 text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-400'
    : state === 'success' ? 'border-green-200 bg-green-50 text-green-600 dark:border-green-900 dark:bg-green-950 dark:text-green-400'
      : 'border-border bg-background text-muted-foreground'
  return <div role={state === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 p-2 rounded-md border text-xs ${colors}`}>
    <Icon className={`h-4 w-4 shrink-0 ${state === 'pending' ? 'animate-spin' : ''}`} />
    <div>{children}</div>
  </div>
}
