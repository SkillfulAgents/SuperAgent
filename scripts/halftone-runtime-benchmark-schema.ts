import { z } from 'zod'

export const halftoneRuntimeBenchmarkFixtureSchema = z.object({
  name: z.enum([
    'flow-one-card-inactive',
    'flow-eight-card-board-inactive',
    'flow-eight-card-board-one-pointer',
    'pulse-one-card-inactive',
    'pulse-eight-card-board-inactive',
  ]),
  motif: z.enum(['flow_3d', 'pulse']),
  cards: z.number().int().positive(),
  pointerCards: z.number().int().nonnegative(),
  cardWidth: z.number().int().positive(),
  cardHeight: z.number().int().positive(),
  columns: z.number().int().positive(),
  rows: z.number().int().positive(),
  dotsPerCard: z.number().int().positive(),
  warmupCount: z.number().int().nonnegative(),
  sampleCount: z.number().int().positive(),
  medianMs: z.number().nonnegative(),
  p95Ms: z.number().nonnegative(),
  minimumMs: z.number().nonnegative(),
  maximumMs: z.number().nonnegative(),
})

export const halftoneRuntimeBenchmarkModeSchema = z.object({
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
  fixtures: z.array(halftoneRuntimeBenchmarkFixtureSchema),
  sameSizeResize: z.object({
    warmupCount: z.number().int().nonnegative(),
    sampleCount: z.number().int().positive(),
    medianMs: z.number().nonnegative(),
    p95Ms: z.number().nonnegative(),
    minimumMs: z.number().nonnegative(),
    maximumMs: z.number().nonnegative(),
  }),
  pointerDispatch: z.object({
    iterationsPerTrial: z.number().int().positive(),
    trials: z.number().int().positive(),
    variants: z.array(
      z.object({
        listenerCount: z.number().int().positive(),
        medianMicrosecondsPerEvent: z.number().nonnegative(),
        p95MicrosecondsPerEvent: z.number().nonnegative(),
      })
    ),
  }),
})

export const halftoneRuntimeBenchmarkResultSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  label: z.string().min(1),
  sourceRevision: z.string().min(1),
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
  }),
  runs: z.array(halftoneRuntimeBenchmarkModeSchema),
})

export type HalftoneRuntimeBenchmarkFixture = z.infer<
  typeof halftoneRuntimeBenchmarkFixtureSchema
>
export type HalftoneRuntimeBenchmarkMode = z.infer<
  typeof halftoneRuntimeBenchmarkModeSchema
>
