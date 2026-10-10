import { z } from 'zod'

export function parseJson<T>(raw: string, schema: z.ZodType<T>): T {
  try { return schema.parse(JSON.parse(raw)) }
  catch (error) { throw new Error('Invalid test JSON', { cause: error }) }
}

export const relativePathSchema = z.string().refine(path => path === '' || path.split('/').every(
  part => part !== '' && part !== '.' && part !== '..' && !/[\\\0]/.test(part),
), 'Only paths inside this test run are allowed')
export const runNameSchema = z.string().regex(/^run-[a-z0-9-]+$/)
export const stateSchema = z.object({
  accountId: z.string().min(1), agentSlug: z.string().regex(/^[a-z0-9]+$/),
  attachmentId: z.string().uuid(), volumeId: z.string().uuid(), runName: runNameSchema,
  root: z.literal('/gamut-test'), mount: z.literal('/mounts/gamut-test'),
})
export const agentSchema = z.object({ slug: z.string() })
export const mountSchema = z.object({ id: z.string().uuid(), volumeId: z.string().uuid(), name: z.literal('gamut-test') })
export const mountsSchema = z.array(mountSchema)
export const dataSchema = z.object({ size: z.number().int().min(0).max(200 * 1024 * 1024), seed: z.string() })
export const workerRequestSchema = z.object({
  runName: runNameSchema, attachmentId: z.string().uuid(),
  op: z.enum(['mkdir', 'write', 'append', 'truncate', 'patch', 'read', 'rename', 'copy', 'unlink', 'rmdir', 'stat', 'list', 'walk', 'git', 'rc', 'webdav', 'open-delete', 'open-rename', 'symlink', 'hardlink', 'exclusive']),
  path: relativePathSchema.default(''), destination: relativePathSchema.optional(),
  data: dataSchema.optional(), offset: z.number().int().nonnegative().optional(), length: z.number().int().nonnegative().optional(),
  text: z.string().max(10_000).optional(),
  recursive: z.boolean().optional(),
  command: z.enum(['vfs/queue', 'vfs/forget', 'vfs/refresh']).optional(),
  method: z.enum(['GET', 'HEAD', 'PROPFIND', 'PUT', 'MOVE', 'MKCOL', 'DELETE']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
})
export const workerReplySchema = z.object({ ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional(), code: z.string().optional() })
export const digestSchema = z.object({ size: z.number(), sha256: z.string() })
export const queueSchema = z.object({ queue: z.array(z.object({ name: z.string(), tries: z.number().optional(), uploading: z.boolean() })) })
export const httpSchema = z.object({ status: z.number(), headers: z.record(z.string(), z.string()), size: z.number(), sha256: z.string(), text: z.string().optional() })
export const reportSchema = z.object({
  root: z.literal('/gamut-test'), runName: runNameSchema, agentSlug: z.string(), startedAt: z.iso.datetime(),
  cases: z.array(z.object({ name: z.string(), passed: z.boolean(), durationMs: z.number(), error: z.string().optional() })),
  downloads: z.array(z.object({ path: relativePathSchema, size: z.number(), sha256: z.string(), verifiedAt: z.iso.datetime() })).default([]),
})

export const summarySchema = z.object({
  root: z.literal('/gamut-test'), runName: runNameSchema, recordedAt: z.iso.datetime(),
  total: z.number().int(), passed: z.number().int(),
  cases: z.array(reportSchema.shape.cases.element.extend({ report: z.string() })),
  reports: z.array(z.string()), downloads: reportSchema.shape.downloads,
})
