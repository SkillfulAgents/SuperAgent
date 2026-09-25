import { codexMediaProvider } from './codex'
import { grokMediaProvider } from './grok'
import type { SubscriptionMediaProvider } from './types'

export const SUBSCRIPTION_MEDIA_PROVIDERS: readonly SubscriptionMediaProvider[] = [codexMediaProvider, grokMediaProvider]
