/**
 * Classifier run service — durable per-fire state for classifier crons.
 *
 * Source of truth for in-flight dedup, escalate spawn, and crash recovery.
 * Keyed by (scheduledTaskId, fireAt).
 */

import { db } from '@shared/lib/db'
import {
  classifierRuns,
  type ClassifierRun,
  type NewClassifierRun,
} from '@shared/lib/db/schema'
import { and, eq } from 'drizzle-orm'

export type { ClassifierRun, NewClassifierRun }

export const CLASSIFIER_STALL_DEADLINE_MS = 10 * 60 * 1000

export interface CreateClassifierRunParams {
  scheduledTaskId: string
  agentSlug: string
  fireAt: Date
  /** Defaults to now + CLASSIFIER_STALL_DEADLINE_MS. */
  deadlineAt?: Date
}

/**
 * Open a fire record. Returns the existing open/resolved row when the unique
 * (taskId, fireAt) already exists (crash-safe claim).
 */
export async function createClassifierRun(
  params: CreateClassifierRunParams,
): Promise<ClassifierRun> {
  const existing = await getClassifierRunByFire(params.scheduledTaskId, params.fireAt)
  if (existing) return existing

  const now = new Date()
  const id = crypto.randomUUID()
  const row: NewClassifierRun = {
    id,
    scheduledTaskId: params.scheduledTaskId,
    agentSlug: params.agentSlug,
    fireAt: params.fireAt,
    status: 'classifying',
    classifySessionId: null,
    verdict: null,
    reason: null,
    escalateSessionId: null,
    deadlineAt: params.deadlineAt ?? new Date(now.getTime() + CLASSIFIER_STALL_DEADLINE_MS),
    resolvedAt: null,
    createdAt: now,
  }

  try {
    await db.insert(classifierRuns).values(row)
  } catch (err) {
    // Unique race: another tick claimed the same fire identity.
    const raced = await getClassifierRunByFire(params.scheduledTaskId, params.fireAt)
    if (raced) return raced
    throw err
  }

  const created = await getClassifierRun(id)
  if (!created) throw new Error(`classifier run ${id} missing after insert`)
  return created
}

export async function getClassifierRun(id: string): Promise<ClassifierRun | null> {
  const rows = await db
    .select()
    .from(classifierRuns)
    .where(eq(classifierRuns.id, id))
  return rows[0] ?? null
}

export async function getClassifierRunByFire(
  scheduledTaskId: string,
  fireAt: Date,
): Promise<ClassifierRun | null> {
  const rows = await db
    .select()
    .from(classifierRuns)
    .where(
      and(
        eq(classifierRuns.scheduledTaskId, scheduledTaskId),
        eq(classifierRuns.fireAt, fireAt),
      ),
    )
  return rows[0] ?? null
}

/** Open (unresolved) fire records. */
export async function getOpenClassifierRuns(): Promise<ClassifierRun[]> {
  return db
    .select()
    .from(classifierRuns)
    .where(eq(classifierRuns.status, 'classifying'))
}

export async function setClassifySessionId(
  runId: string,
  classifySessionId: string,
): Promise<void> {
  await db
    .update(classifierRuns)
    .set({ classifySessionId })
    .where(
      and(
        eq(classifierRuns.id, runId),
        eq(classifierRuns.status, 'classifying'),
      ),
    )
}

export async function markClassifierRunResolved(
  runId: string,
  fields: {
    verdict: 'settle' | 'escalate'
    reason: string
    escalateSessionId?: string | null
  },
): Promise<boolean> {
  const result = await db
    .update(classifierRuns)
    .set({
      status: 'resolved',
      verdict: fields.verdict,
      reason: fields.reason,
      escalateSessionId: fields.escalateSessionId ?? null,
      resolvedAt: new Date(),
    })
    .where(
      and(
        eq(classifierRuns.id, runId),
        eq(classifierRuns.status, 'classifying'),
      ),
    )
  return (result.changes ?? 0) > 0
}

/**
 * Persist a parsed/synthetic verdict on an open run before escalate spawn so a
 * crash between classify-done and escalate can recover from the stored reason.
 */
export async function storeClassifierVerdict(
  runId: string,
  verdict: 'settle' | 'escalate',
  reason: string,
): Promise<void> {
  await db
    .update(classifierRuns)
    .set({ verdict, reason })
    .where(
      and(
        eq(classifierRuns.id, runId),
        eq(classifierRuns.status, 'classifying'),
      ),
    )
}
