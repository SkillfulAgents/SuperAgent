import type { ReactNode } from 'react'
import type { ApiMessage } from '@shared/lib/types/api'
import type { IntegrationMessageDisplay } from '@shared/lib/agent-integrations/message-display-schema'

/** What a provider's message preview receives. */
export interface IntegrationMessageProps {
  /** Host-recorded card data; every string in it is external content. */
  display: IntegrationMessageDisplay
  /** The transcript entry: `content.text` is exactly what the agent received. */
  message: ApiMessage
  /** The app's Markdown rendering, for providers whose text is Markdown. */
  renderMarkdown: (text: string) => ReactNode
  /** The provider's icon tweak (e.g. invert a dark logo in dark mode). */
  iconClassName?: string
}
