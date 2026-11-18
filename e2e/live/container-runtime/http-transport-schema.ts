import { z } from 'zod'

export const imageIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const transportManifestSchema = z.object({
  name: z.string(), description: z.string(),
  scripts: z.object({ start: z.literal('bun run transport-server.mjs') }),
})
export const transportUploadSchema = z.object({
  success: z.literal(true), path: z.string().startsWith('/workspace/uploads/'), size: z.number().int().nonnegative(),
})
export const transportStatsSchema = z.object({ activeSse: z.number().int().nonnegative() })
export const transportVersionsSchema = z.object({
  hono: z.literal('4.13.13'), nodeServer: z.literal('2.1.5'),
  zodValidator: z.literal('0.9.1').optional(),
})
export const browserSocketSchema = z.object({
  protocol: z.literal('transport-v1'), text: z.string(), binary: z.array(z.number().int().min(0).max(255)),
  hostTokenPresent: z.literal(false), closeCode: z.literal(4001), closeReason: z.literal('transport-closed'),
})
export const transportProofSchema = z.object({
  app: z.object({ imageId: imageIdSchema, versions: transportVersionsSchema, endpointVerified: z.literal(true) }),
  agent: z.object({ imageId: imageIdSchema, versions: transportVersionsSchema }),
  checks: z.array(z.string()).min(8),
  uploadBytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  streamedChunks: z.number().int().min(2), abortCycles: z.literal(3),
  socket: browserSocketSchema,
  validationStatuses: z.object({ malformedJson: z.literal(400), invalidSchema: z.literal(400) }),
})
