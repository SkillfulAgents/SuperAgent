import { VolumeError } from './volume-error'

const RETRY_BUDGET_MS = 10_000
const MAX_ATTEMPTS = 4

export function retryAfterSeconds(response: Response, fallback?: number): number | undefined {
  const header = response.headers.get('Retry-After')
  const seconds = header === null ? NaN : Number(header)
  const date = header === null || Number.isFinite(seconds) ? NaN : Date.parse(header)
  return Number.isFinite(seconds) ? Math.max(0, seconds)
    : Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : fallback
}

/** One pacer per provider. Explicit quota rejections delay every call on that
 * account. Only reads retry uncertain failures; replaying a mutation could apply
 * it twice. Long cooldowns return immediately to the caller with Retry-After. */
export class RemoteRequestPacer {
  private readonly cooldowns = new Map<string, number>()
  constructor(private readonly failure: (status: 429 | 503, retryAfter?: number) => VolumeError) {}

  async run<T>(accountId: string, readOnly: boolean, operation: () => Promise<T>): Promise<T> {
    const start = Date.now()
    for (let attempt = 0; ; attempt++) {
      while ((this.cooldowns.get(accountId) ?? 0) > Date.now()) {
        const delay = this.cooldowns.get(accountId)! - Date.now()
        if (Date.now() + delay - start > RETRY_BUDGET_MS) throw this.failure(429, Math.ceil(delay / 1000))
        await new Promise(resolve => setTimeout(resolve, delay))
      }
      try { return await operation() } catch (error) {
        if (!(error instanceof VolumeError) || (error.status !== 429 && !(readOnly && error.status === 503))) throw error
        const delay = Math.max((error.retryAfter ?? 0) * 1000, 250 * 2 ** attempt)
        if (error.status === 429) {
          for (const [id, until] of this.cooldowns) if (until <= Date.now()) this.cooldowns.delete(id)
          this.cooldowns.set(accountId, Math.max(this.cooldowns.get(accountId) ?? 0, Date.now() + delay))
        }
        if (attempt === MAX_ATTEMPTS - 1 || Date.now() + delay - start > RETRY_BUDGET_MS) {
          throw this.failure(error.status, error.status === 429 ? Math.ceil(delay / 1000) : undefined)
        }
        if (error.status !== 429) await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }
}
