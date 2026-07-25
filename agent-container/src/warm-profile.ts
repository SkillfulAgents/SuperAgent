import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { agentCapabilityPoliciesSchema, speedLevelSchema } from './capability-policies';
import type { CreateSessionRequest } from './types';

/**
 * The subset of a create-session request that a pre-warmed CLI subprocess
 * bakes in: everything the query options (and the rendered system prompt)
 * are derived from. Two requests with the same profile can be served by the
 * same warm process; anything else must spawn cold.
 *
 * Deliberately excludes the per-session parts — initialMessage, its uuid,
 * metadata, envVars — which are supplied after the process is claimed.
 */
export const warmProfileSchema = z.object({
  workingDirectory: z.string().optional(),
  systemPrompt: z.string().optional(),
  modelPromptHints: z.array(z.string()).optional(),
  availableEnvVars: z.array(z.string()).optional(),
  model: z.string().optional(),
  browserModel: z.string().optional(),
  dashboardBuilderModel: z.string().optional(),
  webSearchProvider: z.string().optional(),
  webFetchProvider: z.string().optional(),
  maxOutputTokens: z.number().optional(),
  maxThinkingTokens: z.number().optional(),
  maxTurns: z.number().optional(),
  maxBudgetUsd: z.number().optional(),
  customEnvVars: z.record(z.string(), z.string()).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  speed: speedLevelSchema,
  capabilityPolicies: agentCapabilityPoliciesSchema,
});

export type WarmProfile = z.infer<typeof warmProfileSchema>;

/** The shape THIS session runs with — what a parked process must match. */
export function sessionProfileFromRequest(request: CreateSessionRequest): WarmProfile {
  return buildProfile(request, undefined);
}

/**
 * The shape to pre-warm for AFTER serving `request`.
 *
 * Prefers the host's `prewarmDefaults` — the agent default model/effort/speed
 * — over what this session happened to run with. The composer only puts
 * model/effort/speed on the wire when the user explicitly picks one, so the
 * default is what the next session will almost always ask for; warming for a
 * one-off pick instead would cost both a wasted spawn and a cold start.
 * Callers that send no hint (cron, chat, cross-agent) fall back to this
 * session's own shape.
 */
export function nextWarmProfileFromRequest(request: CreateSessionRequest): WarmProfile {
  return buildProfile(request, request.prewarmDefaults);
}

function buildProfile(
  request: CreateSessionRequest,
  defaults: CreateSessionRequest['prewarmDefaults']
): WarmProfile {
  return warmProfileSchema.parse({
    workingDirectory: request.workingDirectory,
    systemPrompt: request.systemPrompt,
    modelPromptHints: defaults ? defaults.modelPromptHints : request.modelPromptHints,
    availableEnvVars: request.availableEnvVars,
    model: defaults ? defaults.model : request.model,
    browserModel: request.browserModel,
    dashboardBuilderModel: request.dashboardBuilderModel,
    webSearchProvider: request.webSearchProvider,
    webFetchProvider: request.webFetchProvider,
    maxOutputTokens: request.maxOutputTokens,
    maxThinkingTokens: request.maxThinkingTokens,
    maxTurns: request.maxTurns,
    maxBudgetUsd: request.maxBudgetUsd,
    customEnvVars: request.customEnvVars,
    effort: defaults ? defaults.effort : request.effort,
    speed: defaults ? defaults.speed : request.speed,
    capabilityPolicies: request.capabilityPolicies,
  });
}

/**
 * Stable identity for a profile. Key equality is the whole safety argument
 * for handing a warm process to a request, so it is computed from a
 * key-sorted serialization rather than plain JSON.stringify (whose output
 * depends on insertion order).
 */
export function warmProfileKey(profile: WarmProfile): string {
  return JSON.stringify(profile, Object.keys(profile).sort());
}

/**
 * The last-used profile, persisted so a container that just booted can warm a
 * subprocess for the session that is about to arrive. Without it the first
 * session after a wake — the slowest case, since nothing is in page cache —
 * would be the one case that never gets a warm process.
 */
export class WarmProfileStore {
  private readonly filePath: string;

  constructor(baseWorkingDirectory: string) {
    this.filePath = path.join(baseWorkingDirectory, '.superagent-warm-profile.json');
  }

  read(): WarmProfile | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      return warmProfileSchema.parse(JSON.parse(fs.readFileSync(this.filePath, 'utf-8')));
    } catch (error) {
      // A stale or hand-edited file must never block session creation: the
      // worst case of ignoring it is one cold start.
      console.error('[WarmProfile] Ignoring unreadable warm profile:', error);
      return null;
    }
  }

  write(profile: WarmProfile): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(warmProfileSchema.parse(profile), null, 2));
    } catch (error) {
      console.error('[WarmProfile] Failed to persist warm profile:', error);
    }
  }
}
