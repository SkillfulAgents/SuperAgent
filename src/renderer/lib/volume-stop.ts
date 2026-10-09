import { volumeStopErrorSchema } from '@shared/lib/container/volume-stop-schema'
import { apiFetch } from './api'

type StopAction = 'Stop' | 'Delete' | 'Restart' | 'Remove volume'
interface Confirmation {
  action: StopAction
  message: string
  resolve: (confirmed: boolean) => void
}
const queue: Confirmation[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(listener => listener())

export const volumeStopConfirmation = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) queue.splice(0).forEach(item => item.resolve(false))
    }
  },
  getSnapshot: () => queue[0] ?? null,
  answer(confirmed: boolean) {
    queue.shift()?.resolve(confirmed)
    emit()
  },
}

/** A failed safe stop is never retried destructively without this confirmation.
 * Queue concurrent requests (e.g. Stop all), giving each its own decision. */
export async function fetchWithVolumeStopConfirmation(path: string, init: RequestInit, action: StopAction): Promise<Response> {
  const response = await apiFetch(path, init)
  if (response.status !== 409) return response
  const parsed = volumeStopErrorSchema.safeParse(await response.clone().json().catch(() => null))
  if (!parsed.success || listeners.size === 0) return response
  const confirmed = await new Promise<boolean>(resolve => {
    queue.push({ action, message: parsed.data.error, resolve })
    emit()
  })
  if (!confirmed) return response
  return apiFetch(`${path}${path.includes('?') ? '&' : '?'}force=true`, init)
}
