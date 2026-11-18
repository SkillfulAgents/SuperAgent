import { z } from 'zod'

export const avatarBenchmarkSampleSchema = z.object({
  variant: z.enum(['baseline', 'working-tree']),
  fixture: z.string(),
  trial: z.number().int().positive(),
  elapsedMs: z.number().positive(),
  taskMs: z.number().nonnegative(),
  scriptMs: z.number().nonnegative(),
  layoutCount: z.number().int().nonnegative(),
  styleCount: z.number().int().nonnegative(),
  frames: z.number().int().nonnegative(),
  rectReads: z.number().int().nonnegative(),
})

export const avatarBenchmarkReportSchema = z.object({
  generatedAt: z.string().datetime(),
  baseline: z.string(),
  workingTreeHead: z.string(),
  browser: z.string(),
  cpu: z.string(),
  platform: z.string(),
  mode: z.literal('headless Chromium component fixture; production React; DPR 2'),
  sampleMs: z.number().positive(),
  warmupMs: z.number().nonnegative(),
  samples: z.array(avatarBenchmarkSampleSchema),
})

export type AvatarBenchmarkSample = z.infer<typeof avatarBenchmarkSampleSchema>
