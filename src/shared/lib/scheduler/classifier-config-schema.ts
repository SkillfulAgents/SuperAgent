/**
 * Zod schemas for classifier cron config (executionMode=classifier).
 *
 * Validated at the service write boundary and when parsing stored JSON
 * from the scheduled_tasks.classifier_config column.
 *
 * PR1 surface only: empty gather, classify/escalate model+effort, handoff.
 * Non-empty gather sources are rejected until the gather runner ships.
 */

import { z } from 'zod'

/** Match schedule_task tool + EFFORT_LEVELS in src/shared/lib/container/types.ts */
export const ModelFamilySchema = z.enum(['opus', 'sonnet', 'haiku'])
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])

export const ExecutionModeSchema = z.enum(['session', 'classifier'])
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>

/**
 * Closed allowlist staged for the gather runner. PR1 rejects any non-empty
 * sources array; kinds are forward-declared so create-time validation can grow
 * without inventing new kind strings later.
 */
export const GATHER_SOURCE_KINDS = [
  'inbox_window',
  'http_json',
  'log_window',
  'record_list',
  'slack_threads',
  'baseline_diff',
  'state_ref',
] as const
export type GatherSourceKind = (typeof GATHER_SOURCE_KINDS)[number]

export const GatherSpecSchema = z.object({
  version: z.literal(1),
  /**
   * PR1: sources must be empty (no host gather runner yet).
   * Classify looks around with normal session tools.
   */
  sources: z.array(z.unknown()).max(0).default([]),
})

export type GatherSpec = z.infer<typeof GatherSpecSchema>

export const ClassifierConfigSchema = z.object({
  gather: GatherSpecSchema,
  /** Escalate/settle rules - classify prompt body (not the gather spec / not the job brief). */
  criteria: z.string().min(1),
  classifyModel: ModelFamilySchema.default('haiku'),
  classifyEffort: EffortSchema.default('low'),
  escalateModel: ModelFamilySchema,
  escalateEffort: EffortSchema,
})

export type ClassifierConfig = z.infer<typeof ClassifierConfigSchema>

/**
 * Fire-time classify handoff. Host assembles the escalate initialMessage;
 * classify does NOT write the escalate prompt.
 *
 * Emission contract: TERMINAL output of the classify session - one fenced
 * ```json block with exactly this shape. Host reads the last fenced json
 * block in the final assistant message once durable terminal evidence exists.
 */
export const ClassifierHandoffSchema = z.object({
  verdict: z.enum(['escalate', 'settle']),
  reason: z.string().min(1),
})
export type ClassifierHandoff = z.infer<typeof ClassifierHandoffSchema>

const SessionJobConfigSchema = z.object({
  executionMode: z.literal('session'),
  prompt: z.string().min(1),
  model: ModelFamilySchema.optional(),
  effort: EffortSchema.optional(),
})

const ClassifierJobConfigSchema = z.object({
  executionMode: z.literal('classifier'),
  /**
   * Job brief (same role as session `prompt`).
   * Classify receives it too: on settle, do the easy version of this brief.
   * On escalate, the host template re-frames the same brief for the second session.
   */
  prompt: z.string().min(1),
  classifier: ClassifierConfigSchema,
})

export const ScheduledJobRuntimeConfigSchema = z.discriminatedUnion('executionMode', [
  SessionJobConfigSchema,
  ClassifierJobConfigSchema,
])

export type ScheduledJobRuntimeConfig = z.infer<typeof ScheduledJobRuntimeConfigSchema>

/** Shared schedule envelope fields that already exist on scheduled_tasks. */
export const ScheduleEnvelopeSchema = z.object({
  name: z.string().optional(),
  scheduleType: z.enum(['at', 'cron']),
  scheduleExpression: z.string().min(1),
  timezone: z.string().optional(),
})

export const CreateScheduledJobSchema = ScheduleEnvelopeSchema.and(ScheduledJobRuntimeConfigSchema)
export type CreateScheduledJob = z.infer<typeof CreateScheduledJobSchema>

/**
 * Validate a classifier_config object before store.
 * Throws if validation fails.
 */
export function validateClassifierConfig(config: unknown): ClassifierConfig {
  return ClassifierConfigSchema.parse(config)
}

/**
 * Safely parse a JSON classifier_config string from the database.
 * Returns null with a logged error if parsing or validation fails.
 */
export function parseClassifierConfig(configJson: string): ClassifierConfig | null {
  try {
    const raw = JSON.parse(configJson)
    return validateClassifierConfig(raw)
  } catch (err) {
    console.error(
      '[ClassifierConfig] Invalid classifier_config:',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/**
 * Validate a fire-time handoff object.
 * Throws if validation fails.
 */
export function validateClassifierHandoff(handoff: unknown): ClassifierHandoff {
  return ClassifierHandoffSchema.parse(handoff)
}

/**
 * Parse a fire-time handoff from a JSON string (or already-parsed object).
 * Returns null on failure (fail closed at the call site → escalate).
 */
export function parseClassifierHandoff(raw: unknown): ClassifierHandoff | null {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw
    return validateClassifierHandoff(value)
  } catch {
    return null
  }
}

/**
 * Narrow a stored execution_mode value at the fire read boundary.
 * Unknown / missing values fall back to today's session path.
 */
export function parseExecutionMode(value: unknown): ExecutionMode {
  const parsed = ExecutionModeSchema.safeParse(value ?? 'session')
  return parsed.success ? parsed.data : 'session'
}
