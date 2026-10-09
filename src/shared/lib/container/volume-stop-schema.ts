import { z } from 'zod'

export const volumeStopResponseSchema = z.object({ ready: z.boolean() })

export class ContainerStopDeferredError extends Error {}
