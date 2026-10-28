import {
  clampIntegrationText, integrationTimestamp, INTEGRATION_MESSAGE_LIMITS,
  type IntegrationMessagePresentation,
} from '../agent-integrations/message-display-schema'
import type { EmailMessage } from './config-schema'

/** Only collapse a trailing quote block; inline replies stay in the visible body. */
export function splitEmailQuote(text: string): { body: string; quote?: string } {
  const lines = text.trimEnd().split('\n')
  let start = lines.length
  while (start > 0 && (/^\s*>/.test(lines[start - 1]) || !lines[start - 1].trim())) start--
  if (start === lines.length) return { body: text }
  // Gmail can wrap its attribution over several lines before the quoted block.
  const attribution = lines.slice(Math.max(0, start - 3), start).join('\n').match(/(?:^|\n)(On [\s\S]*wrote:)\s*$/)
  if (attribution) start -= attribution[1].split('\n').length
  const body = lines.slice(0, start).join('\n').trimEnd()
  // Do not turn a quote-only email into an empty card.
  return body.trim() ? { body, quote: lines.slice(start).join('\n') } : { body: text }
}

/** Display only. The model-facing input and full original body stay unchanged. */
export function describeEmailMessage(message: EmailMessage, text: string): IntegrationMessagePresentation {
  const { body, quote } = splitEmailQuote(text)
  const label = (value: string) => clampIntegrationText(value, 520)
  const name = message.from.match(/^\s*"?([^<>]+?)"?\s*<[^<>]+>\s*$/)?.[1] ?? message.from
  return {
    event: { type: 'message', label: 'Received email' },
    source: { kind: 'thread', title: clampIntegrationText(message.subject?.trim() || '(No subject)', INTEGRATION_MESSAGE_LIMITS.label) },
    request: {
      text: clampIntegrationText(body, INTEGRATION_MESSAGE_LIMITS.requestText),
      author: { name: clampIntegrationText(name || 'Unknown sender', INTEGRATION_MESSAGE_LIMITS.name) },
      sentAt: integrationTimestamp(new Date(message.createdAt)),
    },
    email: {
      from: label(message.from), to: message.to.slice(0, 20).map(label), cc: message.cc.slice(0, 20).map(label),
      replyTo: message.replyTo.slice(0, 20).map(label),
      recipientsTruncated: [message.to, message.cc, message.replyTo].some(values => values.length > 20),
      quotedText: quote ? clampIntegrationText(quote, INTEGRATION_MESSAGE_LIMITS.requestText) : undefined,
      attachmentCount: message.attachments.length,
    },
  }
}
