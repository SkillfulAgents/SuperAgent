import { z } from 'zod'

export const optionsSchema = z.object({
  baseUrl: z.string().url().refine(value => {
    try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname) }
    catch { return false }
  }, 'Use an isolated loopback app'),
  image: z.string().min(1),
  model: z.string().min(1),
  providerId: z.string().min(1),
  output: z.string().min(1),
  timeoutMs: z.coerce.number().int().min(30_000).max(1_800_000),
  expected: z.object({
    node: z.string(), python: z.string(), uv: z.string(), bun: z.string(),
    rclone: z.string(), typescript: z.string(), 'ts-node': z.string(),
  }),
})

export const agentSchema = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/) })
export const sessionSchema = z.object({ id: z.string().min(1) })
export const sessionStateSchema = z.object({ isActive: z.boolean() })
export const receiptSchema = z.object({ success: z.literal(true), uuid: z.string(), queued: z.boolean() })
export const eventSchema = z.object({ type: z.string().min(1).max(100) })
export const artifactManifestSchema = z.object({
  scripts: z.object({ start: z.literal('bun run serve.ts'), widget: z.literal('bun run widget.ts') }),
  gamut: z.object({ widget: z.object({ size: z.enum(['small', 'medium']) }) }),
})
export const widgetRefreshSchema = z.object({
  ok: z.literal(true),
  snapshot: z.object({
    generatedAt: z.string(), validUntil: z.string().nullable(),
    validityDefaulted: z.literal(false), htmlHash: z.string(),
    renderedSizes: z.array(z.string()).length(8),
    scriptRan: z.literal(true), durationMs: z.number(), lastError: z.null(),
  }),
})
export const messagesSchema = z.array(z.object({
  type: z.string(),
  content: z.object({ text: z.string().optional() }).default({}),
  apiError: z.unknown().optional(),
  toolCalls: z.array(z.object({
    id: z.string(), name: z.string(),
    input: z.record(z.string(), z.unknown()).default({}),
    isError: z.boolean().optional(),
  })).default([]),
}))

export const toolEvidenceSchema = z.object({
  phase: z.enum(['initial', 'restart']),
  versions: z.record(z.string(), z.string()),
  checks: z.array(z.string()).min(1),
})

export const projectPythonSchema = z.object({
  version: z.string(), prefix: z.string(), basePrefix: z.string(),
})

const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const containerIdentitySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  imageId,
  image: z.string().min(1),
  running: z.literal(true),
})

export const proofSchema = z.object({
  status: z.literal('passed'),
  runId: z.string().uuid(),
  gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
  baseUrl: z.string().url(),
  model: z.string(),
  providerId: z.string(),
  agentSlug: z.string(),
  sessionId: z.string(),
  before: containerIdentitySchema,
  after: containerIdentitySchema,
  expected: optionsSchema.shape.expected,
  tools: z.array(toolEvidenceSchema).length(2),
  agentProject: z.object({
    initialResult: z.string(), resumedResult: z.string(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    lockSha256: z.string().regex(/^[a-f0-9]{64}$/),
    bashCallsBeforeRestart: z.number().int().positive(),
    bashCallsAfterRestart: z.number().int().positive(),
    pythonBefore: projectPythonSchema,
    pythonAfter: projectPythonSchema,
  }),
  artifact: z.object({
    slug: z.string(), sessionId: z.string(),
    successfulToolCalls: z.number().int().positive(),
    dashboardCounterBefore: z.literal(42), dashboardCounterAfter: z.literal(43),
    snapshot: widgetRefreshSchema.shape.snapshot,
    pngs: z.array(z.object({
      name: z.string(), width: z.number().int().positive(), height: z.number().int().positive(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })).length(8),
  }),
  streamEventCounts: z.record(z.string(), z.number().int().nonnegative()),
  durationMs: z.number().int().positive(),
})
