import { useContext, useMemo, useState } from 'react'
import type { Components } from 'react-markdown'
import { CircleDollarSign, Info, TriangleAlert, type LucideIcon } from 'lucide-react'

import { defaultParseErrorResponse, type ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'

import { RequestError } from '@renderer/components/messages/request-error'
import { Button } from '@renderer/components/ui/button'
import type { ProviderErrorComponentProps } from '@renderer/components/provider-error/provider-error-registry'
import { Markdown } from '@renderer/components/ui/markdown'
import { DialogContext } from '@renderer/context/dialog-context'
import { openExternalUrl } from '@renderer/lib/open-external'

const ICONS: Record<string, LucideIcon> = {
  info: Info,
  'triangle-alert': TriangleAlert,
  'circle-dollar-sign': CircleDollarSign,
}

const OPAQUE_DARK: Record<ProviderErrorPresentation['severity'], string> = {
  error: 'mt-0 dark:bg-red-950',
  warning: 'mt-0 dark:bg-orange-950',
}

// In-app settings links (e.g. `/settings/llm`) navigate here; anything else opens in the browser.
const SETTINGS_LINK = /^\/settings\/([\w-]+)$/

function markdownComponents(openSettings: ((tab: string) => void) | undefined): Components {
  return {
    p: ({ children }) => <span>{children}</span>,
    strong: ({ children }) => <strong className="font-medium">{children}</strong>,
    a: ({ href, children }) => {
      const settingsTab = href?.match(SETTINGS_LINK)?.[1]
      return (
        <a
          href={href}
          {...(settingsTab ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
          className="font-medium underline-offset-2 hover:underline"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            if (settingsTab) openSettings?.(settingsTab)
            else if (href) void openExternalUrl(href)
          }}
        >
          {children}
        </a>
      )
    },
  }
}

function defaultHint(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('invalid or revoked') || lower.includes('authentication') || lower.includes('401')) {
    return 'Your access token may have expired or been revoked. Please reconnect your platform account in Settings.'
  }
  return 'This error came from the external LLM provider API, not from this application. Check your provider configuration in Settings.'
}

function hasMarkdownLink(markdown: string): boolean {
  return /\[[^\]]+\]\([^)]+\)/.test(markdown)
}

export function ProviderErrorView({
  presentation,
  rawMessage,
  'data-testid': testId,
}: {
  presentation: ProviderErrorPresentation
  rawMessage?: string
  'data-testid'?: string
}) {
  const Icon = ICONS[presentation.icon] ?? Info
  // Nullable: router-free hosts mount no DialogProvider, so settings links do nothing there.
  const openSettings = useContext(DialogContext)?.openSettings
  const components = useMemo(() => markdownComponents(openSettings), [openSettings])

  return (
    <RequestError
      label={null}
      message={
        <Markdown components={components}>{presentation.message}</Markdown>
      }
      hint={hasMarkdownLink(presentation.message) ? undefined : defaultHint(rawMessage ?? presentation.message)}
      severity={presentation.severity}
      icon={Icon}
      className={OPAQUE_DARK[presentation.severity]}
      data-testid={testId ?? 'provider-error-card'}
    />
  )
}

// `presentation` is authored server-side by the active LLM provider's
// presentationForTurnError. Without one (older server, missed event) the card falls
// back to the provider-agnostic default banner built from the raw message.
export function ProviderErrorCard({
  message,
  presentation,
  dismissible = false,
  'data-testid': testId,
}: ProviderErrorComponentProps & { 'data-testid'?: string }) {
  const [dismissed, setDismissed] = useState(false)
  const resolved = useMemo(
    () => presentation ?? defaultParseErrorResponse(undefined, message),
    [presentation, message],
  )
  if (dismissed) return null
  return (
    <>
      <ProviderErrorView
        presentation={resolved}
        rawMessage={message}
        data-testid={testId}
      />
      {dismissible && (
        <div className="mt-1 flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>Dismiss</Button>
        </div>
      )}
    </>
  )
}
