import { z } from 'zod'

export const halftoneBenchmarkStrategySchema = z.object({
  name: z.enum(['per-dot', 'alpha-buckets']),
  alphaBands: z.number().int().positive().nullable(),
  medianMs: z.number().nonnegative(),
  p95Ms: z.number().nonnegative(),
  minimumMs: z.number().nonnegative(),
  maximumMs: z.number().nonnegative(),
})

export const halftoneBenchmarkFixtureSchema = z.object({
  name: z.enum(['one-wide-card', 'eight-wide-card-board']),
  cards: z.number().int().positive(),
  cardWidth: z.number().int().positive(),
  cardHeight: z.number().int().positive(),
  columns: z.number().int().positive(),
  rows: z.number().int().positive(),
  dotsPerCard: z.number().int().positive(),
  warmupCount: z.number().int().nonnegative(),
  sampleCount: z.number().int().positive(),
  strategies: z.array(halftoneBenchmarkStrategySchema),
})

export const halftoneBenchmarkModeSchema = z.object({
  mode: z.enum(['headed-gpu', 'headless-software']),
  headless: z.boolean(),
  browserVersion: z.string().min(1),
  launchArgs: z.array(z.string()),
  gpu: z.object({
    devices: z.array(
      z.object({
        vendorString: z.string(),
        deviceString: z.string(),
        driverVendor: z.string(),
        driverVersion: z.string(),
      })
    ),
    featureStatus: z.record(z.string(), z.string()),
  }),
  fixtures: z.array(halftoneBenchmarkFixtureSchema),
})

export const halftoneBenchmarkGateSchema = z.object({
  name: z.string().min(1),
  mode: z.enum(['headed-gpu', 'headless-software']),
  actual: z.number(),
  requirement: z.string().min(1),
  passed: z.boolean(),
})

export const halftoneBenchmarkResultSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  environment: z.object({
    platform: z.string().min(1),
    release: z.string().min(1),
    architecture: z.string().min(1),
    cpu: z.string().min(1),
    logicalCpuCount: z.number().int().positive(),
    viewportWidth: z.number().int().positive(),
    viewportHeight: z.number().int().positive(),
    devicePixelRatio: z.number().positive(),
  }),
  config: z.object({
    warmupCount: z.number().int().nonnegative(),
    sampleCount: z.number().int().positive(),
    alphaBands: z.array(z.number().int().positive()),
  }),
  runs: z.array(halftoneBenchmarkModeSchema),
  gates: z.array(halftoneBenchmarkGateSchema),
  passed: z.boolean(),
})

export type HalftoneBenchmarkFixture = z.infer<typeof halftoneBenchmarkFixtureSchema>
export type HalftoneBenchmarkMode = z.infer<typeof halftoneBenchmarkModeSchema>
export type HalftoneBenchmarkGate = z.infer<typeof halftoneBenchmarkGateSchema>
export type HalftoneBenchmarkResult = z.infer<typeof halftoneBenchmarkResultSchema>
