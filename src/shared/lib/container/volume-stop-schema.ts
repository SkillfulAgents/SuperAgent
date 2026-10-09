import { z } from 'zod'

export const volumeStopResponseSchema = z.object({
  ready: z.boolean(),
  workStopped: z.boolean().default(true),
})

export const volumeStopErrorSchema = z.object({
  code: z.literal('volume_stop_deferred'),
  error: z.string(),
  workStopped: z.boolean(),
})

export const forceStopQuerySchema = z.enum(['true', 'false']).optional()

// Inspect the running generation, not today's database attachments: an unhealthy
// or newly detached volume can still have queued bytes in the container.
export const volumeRuntimeStateSchema = z.object({
  State: z.object({ Running: z.boolean() }),
  Config: z.object({ Env: z.array(z.string()).nullish() }).optional(),
})

export function runtimeHasVolumes(container: unknown): boolean | undefined {
  const state = volumeRuntimeStateSchema.safeParse(container)
  if (!state.success) return undefined
  if (!state.data.State.Running) return false
  if (!state.data.Config) return undefined
  const raw = state.data.Config.Env?.find(value => value.startsWith('SUPERAGENT_VOLUMES='))
  if (!raw) return false
  try {
    return z.array(z.unknown()).parse(JSON.parse(raw.slice('SUPERAGENT_VOLUMES='.length))).length > 0
  } catch {
    return undefined
  }
}

export class ContainerStopDeferredError extends Error {
  constructor(message: string, readonly workStopped = false) { super(message) }

  toResponse(): z.infer<typeof volumeStopErrorSchema> {
    return { code: 'volume_stop_deferred', error: this.message, workStopped: this.workStopped }
  }
}
