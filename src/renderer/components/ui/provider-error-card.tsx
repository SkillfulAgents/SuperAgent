import { useMemo } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import { CircleDollarSign, Info, TriangleAlert, type LucideIcon } from 'lucide-react'

import { defaultParseErrorResponse, type ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'
import type { PaywallBillingDetails, PaywallCta } from '@shared/lib/llm-provider/paywall-cta'

import { HomeEmptyClouds } from '@renderer/components/home/home-empty-clouds'
import { RequestError } from '@renderer/components/messages/request-error'
import { PaywallActions, type PaywallResumeTarget } from '@renderer/components/ui/paywall-actions'
import { usePaywallCta } from '@renderer/hooks/use-paywall-cta'
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

// Paywall messages lead with a **bold** segment; it becomes the card title and
// the remainder the subtitle. A trailing colon inside the bold is dropped so
// older "**Insufficient Balance:**"-style messages still read as a title.
function splitPaywallMessage(markdown: string): { title: string; body: string } {
  const match = markdown.match(/^\*\*(.+?):?\*\*\s*([\s\S]*)$/)
  if (match) return { title: match[1], body: match[2] }
  return { title: markdown, body: '' }
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

function formatStatus(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function paywallSubtitle(
  cta: PaywallCta | null,
  details: PaywallBillingDetails | null,
  fallback: string,
): string {
  if (cta?.kind === 'subscribe') return 'Start a subscription to continue using this workspace.'
  if (cta?.kind === 'add_card') return 'Add a payment method before purchasing more usage credit.'
  if (cta?.kind === 'topup') return 'Add usage credit to resume this answer.'
  if (cta?.kind === 'manage_payment') return 'Your payment needs attention before agents can continue.'
  if (cta?.kind === 'ask_admin') {
    const paymentIssue = details?.paymentStatus
      && ['past_due', 'blocked', 'payment_failed'].includes(details.paymentStatus)
    return paymentIssue
      ? 'Ask a workspace admin to resolve the payment issue.'
      : 'Ask a workspace admin to add usage credit to this organization.'
  }
  return fallback
}

function paywallTitle(cta: PaywallCta | null, fallback: string): string {
  if (cta?.kind === 'subscribe') return 'Subscribe to keep going'
  if (cta?.kind === 'add_card') return 'Add a payment method'
  if (cta?.kind === 'manage_payment') return 'Payment needs attention'
  if (cta?.kind === 'ask_admin') return 'Workspace billing needs attention'
  return fallback
}

function PaywallBillingSummary({ details }: { details: PaywallBillingDetails }) {
  const items = [
    details.subscriptionStatus && `Plan ${formatStatus(details.subscriptionStatus)}`,
    details.paymentStatus && `Payment ${formatStatus(details.paymentStatus)}`,
    details.seatBalanceCents != null && `Seat ${formatMoney(details.seatBalanceCents)}`,
    `Organization ${formatMoney(details.orgPoolBalanceCents)}`,
    details.hasPaymentMethod === true && 'Card on file',
    details.hasPaymentMethod === false && 'No card',
    details.autoReload === undefined
      ? null
      : details.autoReload?.enabled
        ? `Auto-reload on${
          details.autoReload.thresholdCents != null && details.autoReload.topupAmountCents != null
            ? ` (${formatMoney(details.autoReload.topupAmountCents)} at ${formatMoney(details.autoReload.thresholdCents)})`
            : ''
        }`
        : 'Auto-reload off',
  ].filter((item): item is string => Boolean(item))

  return (
    <p className="mt-2 text-xs text-muted-foreground" data-testid="paywall-billing-summary">
      {items.join(' · ')}
    </p>
  )
}

// The paywall is an invitation, not a failure: neutral card, no error reds.
// Title + muted subtitle on the left, the CTA on the right.
function PaywallCard({
  presentation,
  cta,
  details,
  loading,
  resumeTarget,
  'data-testid': testId,
}: {
  presentation: ProviderErrorPresentation
  cta: PaywallCta | null
  details: PaywallBillingDetails | null
  loading: boolean
  resumeTarget?: PaywallResumeTarget
  'data-testid'?: string
}) {
  const message = splitPaywallMessage(presentation.message)
  const title = paywallTitle(cta, message.title)
  const subtitle = paywallSubtitle(cta, details, message.body)

  return (
    <div className="relative mt-4">
      {/* Wandering spectral bloom (the Home empty-state glow) as a soft halo
          behind the card — unmasked so it spills past the card's edges. */}
      <HomeEmptyClouds masked={false} fill={0.6} />
      <div
        data-testid={testId ?? 'provider-error-card'}
        data-paywall=""
        className="relative flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-card px-5 py-4 shadow-sm"
      >
        <div className="min-w-0 flex-1 basis-60">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {subtitle && (
            <p className="mt-0.5 text-sm text-muted-foreground">
              <ReactMarkdown
                urlTransform={markdownUrlTransform}
                components={MARKDOWN_COMPONENTS}
              >
                {subtitle}
              </ReactMarkdown>
            </p>
          )}
          {details && <PaywallBillingSummary details={details} />}
        </div>
        <PaywallActions cta={cta} loading={loading} resumeTarget={resumeTarget} />
      </div>
    </div>
  )
}

export function ProviderErrorView({
  presentation,
  rawMessage,
  paywallCta = null,
  paywallDetails = null,
  paywallLoading = false,
  resumeTarget,
  'data-testid': testId,
}: {
  presentation: ProviderErrorPresentation
  rawMessage?: string
  paywallCta?: PaywallCta | null
  paywallDetails?: PaywallBillingDetails | null
  paywallLoading?: boolean
  resumeTarget?: PaywallResumeTarget
  'data-testid'?: string
}) {
  if (presentation.paywall) {
    return (
      <PaywallCard
        presentation={presentation}
        cta={paywallCta}
        details={paywallDetails}
        loading={paywallLoading}
        resumeTarget={resumeTarget}
        data-testid={testId}
      />
    )
  }

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
      hint={
        hasMarkdownLink(presentation.message)
          ? undefined
          : defaultHint(rawMessage ?? presentation.message)
      }
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
  resumeTarget,
  'data-testid': testId,
}: {
  message: string
  presentation?: ProviderErrorPresentation
  resumeTarget?: PaywallResumeTarget
  'data-testid'?: string
}) {
  const base = useMemo(
    () => presentation ?? defaultParseErrorResponse(undefined, message),
    [presentation, message],
  )
  const resolved = useResolvedErrorPresentation(base)
  const paywall = usePaywallCta(resolved)
  return (
    <ProviderErrorView
      presentation={resolved}
      rawMessage={message}
      paywallCta={paywall.cta}
      paywallDetails={paywall.details}
      paywallLoading={paywall.loading}
      resumeTarget={resumeTarget}
      data-testid={testId}
    />
  )
}
