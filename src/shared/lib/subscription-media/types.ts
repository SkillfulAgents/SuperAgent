import type { resolveConnectionCredential } from '../llm-provider/connection-credentials'
import type { LlmProviderId } from '../llm-provider/provider-types'

export interface GeneratedMedia {
  mimeType: string
  base64: string
}

export type MediaCredentialSource = (rejectedGeneration?: number) => ReturnType<typeof resolveConnectionCredential>

/** Media generation backed by a user's own subscription connection. Each
 * provider validates its own input; the shared route only selects the account. */
export interface SubscriptionMediaProvider {
  readonly id: string
  readonly name: string
  readonly llmProviderId: LlmProviderId
  readonly extraPrompt: string
  generateImage(input: unknown, credential: MediaCredentialSource): Promise<GeneratedMedia[]>
}

/** A failure whose message is safe to return to the agent. */
export class MediaRequestError extends Error {
  constructor(readonly status: 400 | 402 | 403 | 429 | 502, message: string) {
    super(message)
  }
}
