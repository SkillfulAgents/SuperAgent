import { z } from 'zod'
import { getSettings, type ApiKeyStatus } from '../config/settings'
import { BaseDecisionProvider } from './decision-provider'
import { decodeSystemOne, encodeSystemOne } from './systemone'
import type { DecisionRequest, DecisionResult } from './types'

/** Workers AI wraps the System One answer in its standard `{ result }` envelope. */
const envelopeSchema = z.object({ result: z.unknown() })

export class CloudflareDecisionProvider extends BaseDecisionProvider {
  readonly id = 'cloudflare' as const
  readonly name = 'Cloudflare'
  readonly model = 'clef'
  protected readonly settingsKeyField = 'cloudflareApiToken' as const
  protected readonly envVarName = 'CLOUDFLARE_API_TOKEN'

  private accountId(): string | undefined {
    return getSettings().apiKeys?.cloudflareAccountId || process.env.CLOUDFLARE_ACCOUNT_ID
  }

  override getApiKeyStatus(): ApiKeyStatus {
    return this.accountId() ? super.getApiKeyStatus() : { isConfigured: false, source: 'none' }
  }

  private accountUrl(): string {
    const accountId = this.accountId()
    if (!accountId) throw new Error('No Cloudflare account ID configured.')
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`
  }

  protected endpointUrl(model: string): string {
    return `${this.accountUrl()}/ai/run/@cf/cloudflare/${encodeURIComponent(model)}`
  }

  // Needs the account ID first; also proves the token can use Workers AI.
  protected keyCheckUrl(): string {
    return `${this.accountUrl()}/ai/models/search?per_page=1`
  }

  protected encode(request: DecisionRequest, model: string): unknown {
    return encodeSystemOne(request, model)
  }

  protected decode(body: unknown): DecisionResult {
    return decodeSystemOne(envelopeSchema.parse(body).result)
  }
}
