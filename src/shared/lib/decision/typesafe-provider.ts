import { BaseDecisionProvider } from './decision-provider'
import { decodeSystemOne, encodeSystemOne } from './systemone'
import type { DecisionRequest, DecisionResult } from './types'

export class TypesafeDecisionProvider extends BaseDecisionProvider {
  readonly id = 'typesafe' as const
  readonly name = 'TypeSafe'
  readonly model = 'jev-latest'
  protected readonly settingsKeyField = 'typesafeApiKey' as const
  protected readonly envVarName = 'TYPESAFE_API_KEY'

  protected endpointUrl(): string {
    return 'https://api.typesafe.ai/v1/systemone'
  }

  protected keyCheckUrl(): string {
    return 'https://api.typesafe.ai/v1/models'
  }

  protected encode(request: DecisionRequest, model: string): unknown {
    return encodeSystemOne(request, model)
  }

  protected decode(body: unknown): DecisionResult {
    return decodeSystemOne(body)
  }
}
