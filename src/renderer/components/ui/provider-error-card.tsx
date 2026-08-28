import { useMemo } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import { CircleDollarSign, Info, TriangleAlert, type LucideIcon } from 'lucide-react'

import { defaultParseErrorResponse, type ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'

import { RequestError } from '@renderer/components/messages/request-error'
import { useResolvedErrorPresentation } from '@renderer/hooks/use-provider-error-presentation'
import { markdownUrlTransform } from '@renderer/lib/markdown-url-transform'
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

const MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => <span>{children}</span>,
  strong: ({ children }) => <strong className="font-medium">{children}</strong>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium underline-offset-2 hover:underline"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (href) void openExternalUrl(href)
      }}
    >
      {children}
    </a>
  ),
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

  return (
    <RequestError
      label={null}
      message={
        <ReactMarkdown
          urlTransform={markdownUrlTransform}
          components={MARKDOWN_COMPONENTS}
        >
          {presentation.message}
        </ReactMarkdown>
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
// parseErrorResponse. Without one (older server, missed event) the card falls
// back to the provider-agnostic default banner built from the raw message.
export function ProviderErrorCard({
  message,
  presentation,
  'data-testid': testId,
}: {
  message: string
  presentation?: ProviderErrorPresentation
  'data-testid'?: string
}) {
  const base = useMemo(
    () => presentation ?? defaultParseErrorResponse(undefined, message),
    [presentation, message],
  )
  const resolved = useResolvedErrorPresentation(base)
  return (
    <ProviderErrorView
      presentation={resolved}
      rawMessage={message}
      data-testid={testId}
    />
  )
}
