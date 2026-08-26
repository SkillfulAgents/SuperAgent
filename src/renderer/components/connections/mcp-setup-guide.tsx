import { Fragment, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import type { McpSetupGuide as McpSetupGuideData } from '@shared/lib/mcp/common-servers'
import { Button } from '@renderer/components/ui/button'

/**
 * Substitute the redirect tokens a setup step may carry. The redirect is passed
 * in from the API rather than rebuilt here, so what a user copies into a provider
 * console is the same string the OAuth flow later sends.
 */
export function resolveSetupStep(step: string, redirectUri: string): string {
  let origin = ''
  let host = ''
  try {
    const parsed = new URL(redirectUri)
    // A custom app scheme parses without throwing but yields the literal string
    // "null" for origin, so gate on the protocol rather than on a thrown error.
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      origin = parsed.origin
      host = parsed.host
    }
  } catch {
    // Leave the tokens empty rather than rendering a broken URL.
  }
  return step
    .replaceAll('{{redirectUri}}', redirectUri)
    .replaceAll('{{redirectOrigin}}', origin)
    .replaceAll('{{redirectHost}}', host)
}

/**
 * Render the tiny inline subset a setup step may use: `code` for strings the user
 * copies into a provider console, and [label](url) for the console itself. Split
 * into React nodes rather than injected as HTML, so a step can never carry markup.
 *
 * Links are restricted to https to keep a catalog entry from introducing a
 * javascript: or file: target.
 */
const STEP_INLINE = /`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g

export function renderStepInline(step: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let key = 0
  for (const match of step.matchAll(STEP_INLINE)) {
    const index = match.index ?? 0
    if (index > last) nodes.push(step.slice(last, index))
    const [, code, label, href] = match
    if (code !== undefined) {
      nodes.push(
        <code key={key++} className="rounded bg-muted px-1 py-0.5 font-mono text-[10.5px]">
          {code}
        </code>,
      )
    } else {
      nodes.push(
        <a
          key={key++}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2"
        >
          {label}
        </a>,
      )
    }
    last = index + match[0].length
  }
  if (last < step.length) nodes.push(step.slice(last))
  return nodes
}

/** Loopback redirects carry a port that can shift between runs. */
export function isLoopbackRedirect(redirectUri: string): boolean {
  try {
    const { hostname } = new URL(redirectUri)
    return hostname === 'localhost' || hostname === '127.0.0.1'
  } catch {
    return false
  }
}

interface McpSetupGuideProps {
  guide: McpSetupGuideData
  /** The redirect this deployment will send, or undefined while it loads. */
  redirectUri?: string
}

export function McpSetupGuide({ guide, redirectUri }: McpSetupGuideProps) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    if (!redirectUri) return
    await navigator.clipboard.writeText(redirectUri)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 space-y-2"
      data-testid="mcp-setup-guide"
    >
      <div className="text-[11px] font-medium">Set this up with the provider first</div>

      <ol className="list-decimal space-y-1 pl-4 text-[11px] text-muted-foreground">
        {guide.steps.map((step) => (
          <li key={step}>
            {renderStepInline(redirectUri ? resolveSetupStep(step, redirectUri) : step).map(
              (node, i) => (
                <Fragment key={i}>{node}</Fragment>
              ),
            )}
          </li>
        ))}
      </ol>

      {redirectUri && (
        <div className="space-y-1">
          <div className="text-[11px] font-medium">Callback URL</div>
          <div className="flex items-center gap-1.5">
            <code
              className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-1 text-[11px]"
              title={redirectUri}
              data-testid="mcp-setup-guide-redirect"
            >
              {redirectUri}
            </code>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-6 w-6 shrink-0"
              onClick={handleCopy}
              aria-label="Copy callback URL"
              data-testid="mcp-setup-guide-copy"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </Button>
          </div>
        </div>
      )}

      {guide.desktopNote && redirectUri && isLoopbackRedirect(redirectUri) && (
        <div className="text-[11px] text-muted-foreground/80">{guide.desktopNote}</div>
      )}
    </div>
  )
}
