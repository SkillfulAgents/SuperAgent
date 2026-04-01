import { type ReactNode } from 'react'
import { Check, Loader2, Clock, ShieldCheck, type LucideIcon } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@shared/lib/utils/cn'
import { DeclineButton } from './decline-button'

type RequestStatus = 'pending' | 'submitting' | 'executed' | 'denied'

/** Color theme tokens — all Tailwind classes keyed by usage */
export interface ColorTheme {
  bg: string                   // e.g. 'bg-blue-50 dark:bg-blue-950/50'
  border: string               // e.g. 'border-blue-200 dark:border-blue-800'
  iconBg: string               // e.g. 'bg-blue-100 dark:bg-blue-900'
  iconText: string             // e.g. 'text-blue-600 dark:text-blue-400'
  titleText: string            // e.g. 'text-blue-900 dark:text-blue-100'
  subtitleText: string         // e.g. 'text-blue-700 dark:text-blue-300'
  bodyText: string             // e.g. 'text-blue-800 dark:text-blue-200'
  badgeBg: string              // e.g. 'bg-blue-200 dark:bg-blue-800'
  badgeText: string            // e.g. 'text-blue-700 dark:text-blue-300'
  mutedText: string            // e.g. 'text-blue-600 dark:text-blue-400'
  btnOutlineBorder: string     // e.g. 'border-blue-300 dark:border-blue-700'
  btnOutlineText: string       // e.g. 'text-blue-700 dark:text-blue-300'
  btnOutlineHover: string      // e.g. 'hover:bg-blue-100 dark:hover:bg-blue-900'
  btnPrimaryBg: string         // e.g. 'bg-blue-600 hover:bg-blue-700'
  declineBorder: string        // e.g. 'border-blue-200 dark:border-blue-700'
}

export const BLUE_THEME: ColorTheme = {
  bg: 'bg-blue-50 dark:bg-blue-950/50',
  border: 'border-blue-200 dark:border-blue-800',
  iconBg: 'bg-blue-100 dark:bg-blue-900',
  iconText: 'text-blue-600 dark:text-blue-400',
  titleText: 'text-blue-900 dark:text-blue-100',
  subtitleText: 'text-blue-700 dark:text-blue-300',
  bodyText: 'text-blue-800 dark:text-blue-200',
  badgeBg: 'bg-blue-200 dark:bg-blue-800',
  badgeText: 'text-blue-700 dark:text-blue-300',
  mutedText: 'text-blue-600 dark:text-blue-400',
  btnOutlineBorder: 'border-blue-300 dark:border-blue-700',
  btnOutlineText: 'text-blue-700 dark:text-blue-300',
  btnOutlineHover: 'hover:bg-blue-100 dark:hover:bg-blue-900',
  btnPrimaryBg: 'bg-blue-600 hover:bg-blue-700',
  declineBorder: 'border-blue-200 dark:border-blue-700',
}

export function formatParams(params: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') {
      parts.push(`${key}: ${typeof val === 'string' ? val : JSON.stringify(val)}`)
    }
  }
  return parts.join(', ')
}

interface PermissionRequestCardProps {
  /** Display config */
  title: string
  icon: LucideIcon
  theme: ColorTheme
  testIdPrefix: string
  permissionLabel: string
  scopeLabel?: string                // e.g. appName or domain
  method: string
  params: Record<string, unknown>
  warningText: string

  /** State */
  status: RequestStatus
  error: string | null
  readOnly?: boolean

  /** Handlers */
  onApprove: (grantType: 'once' | 'timed' | 'always') => void
  onDeny: (reason?: string) => void

  /** Optional extra content rendered between the header and the buttons */
  extraContent?: ReactNode
  /** Optional extra content rendered between buttons and warning */
  extraActions?: ReactNode
}

/** Completed state — shared by all permission request types */
export function CompletedRequestCard({
  icon: Icon,
  method,
  scopeLabel,
  status,
  testIdPrefix,
}: {
  icon: LucideIcon
  method: string
  scopeLabel?: string
  status: 'executed' | 'denied'
  testIdPrefix: string
}) {
  return (
    <div className="border rounded-md bg-muted/30 text-sm" data-testid={`${testIdPrefix}-request-completed`} data-status={status}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon
          className={cn(
            'h-4 w-4 shrink-0',
            status === 'executed' ? 'text-green-500' : 'text-red-500'
          )}
        />
        <span className="text-sm">{method}{scopeLabel ? ` (${scopeLabel})` : ''}</span>
        <span
          className={cn(
            'ml-auto text-xs',
            status === 'executed' ? 'text-green-600' : 'text-red-600'
          )}
        >
          {status === 'executed' ? 'Executed' : 'Denied'}
        </span>
      </div>
    </div>
  )
}

/** Read-only state — shared by all permission request types */
export function ReadOnlyRequestCard({
  icon: Icon,
  title,
  method,
  scopeLabel,
  theme,
}: {
  icon: LucideIcon
  title: string
  method: string
  scopeLabel?: string
  theme: ColorTheme
}) {
  return (
    <div className={cn('border rounded-md text-sm', theme.bg, theme.border)}>
      <div className="flex items-center gap-3 p-3">
        <div className={cn('h-8 w-8 rounded-full flex items-center justify-center shrink-0', theme.iconBg)}>
          <Icon className={cn('h-4 w-4', theme.iconText)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className={cn('font-medium', theme.titleText)}>
            {title}
          </div>
          <p className={cn('text-sm mt-0.5', theme.subtitleText)}>
            {method}{scopeLabel ? ` — ${scopeLabel}` : ''}
          </p>
        </div>
        <span className={cn('text-xs shrink-0', theme.mutedText)}>Waiting for approval</span>
      </div>
    </div>
  )
}

/** Pending/submitting state — the full interactive card */
export function PermissionRequestCard({
  title,
  icon: Icon,
  theme,
  testIdPrefix,
  permissionLabel,
  scopeLabel,
  method,
  params,
  warningText,
  status,
  error,
  onApprove,
  onDeny,
  extraContent,
  extraActions,
}: PermissionRequestCardProps) {
  const paramStr = formatParams(params)

  return (
    <div className={cn('border rounded-md text-sm', theme.bg, theme.border)} data-testid={`${testIdPrefix}-request`}>
      <div className="flex items-start gap-3 p-3">
        <div className={cn('h-8 w-8 rounded-full flex items-center justify-center shrink-0', theme.iconBg)}>
          <Icon className={cn('h-4 w-4', theme.iconText)} />
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <div>
            <div className="flex items-center gap-2">
              <span className={cn('font-medium', theme.titleText)}>
                {title}
              </span>
              <span className={cn('text-xs px-1.5 py-0.5 rounded', theme.badgeBg, theme.badgeText)}>
                {permissionLabel}
              </span>
              {scopeLabel && (
                <span className={cn('text-xs px-1.5 py-0.5 rounded', theme.badgeBg, theme.badgeText)}>
                  {scopeLabel}
                </span>
              )}
            </div>
            <p className={cn('text-sm mt-1 font-mono', theme.bodyText)}>
              {method}{paramStr ? `(${paramStr})` : '()'}
            </p>
          </div>

          {extraContent}

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => onApprove('once')}
              disabled={status === 'submitting'}
              size="sm"
              variant="outline"
              className={cn(theme.btnOutlineBorder, theme.btnOutlineText, theme.btnOutlineHover)}
              data-testid={`${testIdPrefix}-allow-once-btn`}
            >
              {status === 'submitting' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              <span className="ml-1">Allow Once</span>
            </Button>

            <Button
              onClick={() => onApprove('timed')}
              disabled={status === 'submitting'}
              size="sm"
              className={cn(theme.btnPrimaryBg, 'text-white')}
              data-testid={`${testIdPrefix}-allow-timed-btn`}
            >
              <Clock className="h-4 w-4" />
              <span className="ml-1">Allow 15 min</span>
            </Button>

            <Button
              onClick={() => onApprove('always')}
              disabled={status === 'submitting'}
              size="sm"
              variant="outline"
              className={cn(theme.btnOutlineBorder, theme.btnOutlineText, theme.btnOutlineHover)}
              data-testid={`${testIdPrefix}-allow-always-btn`}
            >
              <ShieldCheck className="h-4 w-4" />
              <span className="ml-1">Always Allow</span>
            </Button>

            <DeclineButton
              onDecline={onDeny}
              disabled={status === 'submitting'}
              className={cn(theme.declineBorder, theme.btnOutlineText, theme.btnOutlineHover)}
              data-testid={`${testIdPrefix}-deny-btn`}
            />
          </div>

          {extraActions}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <p className={cn('text-xs', theme.mutedText)}>
            {warningText}
          </p>
        </div>
      </div>
    </div>
  )
}
