import { captureException, captureMessage } from '@shared/lib/error-reporting'
import type { ContainerClient } from './types'
import { volumeStopResponseSchema } from './volume-stop-schema'

/** The agent gets 15s to stop writers/drain and 3s to preserve its cache. This
 * hook always returns: pending uploads must never veto stop/delete/restart. */
export async function prepareVolumeStop(client: Pick<ContainerClient, 'fetch'>, agentId: string): Promise<void> {
  const signal = AbortSignal.timeout(20_000)
  let abort = () => {}
  const timeout = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    await Promise.race([timeout, (async () => {
      const response = await client.fetch('/volumes/prepare-stop', { method: 'POST', signal })
      if (response.status === 404) return // Older images retain their existing shutdown behavior.
      if (!response.ok) throw new Error(`Volume preparation returned ${response.status}`)
      const result = volumeStopResponseSchema.parse(await response.json())
      if (!result.drained || result.recoveryErrors > 0) {
        captureMessage('Volume uploads unfinished at stop; workspace recovery required', {
          level: 'warning', tags: { component: 'volumes', operation: 'stop-recovery' },
          extra: { agentId, ...result },
        })
      }
    })()])
  } catch (error) {
    // The cache lives in the workspace even if the API cannot move it into the
    // recovery folder. Report the failed handshake and use normal runtime stop.
    captureException(error, {
      tags: { component: 'volumes', operation: 'prepare-stop' },
      extra: { agentId, recoveryDirectory: '.volume-cache' },
    })
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
