import { providerErrorPresentationSchema, type ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'

/** A failed request whose body carries a provider error card, e.g. "reconnect this provider". */
export class ProviderRequestError extends Error {
  constructor(message: string, readonly presentation: ProviderErrorPresentation) {
    super(message)
    this.name = 'ProviderRequestError'
  }
}

export async function readRequestError(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => null) as { error?: unknown; errorPresentation?: unknown } | null
  const message = typeof body?.error === 'string' && body.error ? body.error : fallback
  const presentation = providerErrorPresentationSchema.safeParse(body?.errorPresentation)
  return presentation.success ? new ProviderRequestError(message, presentation.data) : new Error(message)
}
