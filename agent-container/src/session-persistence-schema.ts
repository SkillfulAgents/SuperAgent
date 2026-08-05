import { z } from 'zod';
import { agentCapabilityPoliciesSchema, speedLevelSchema } from './capability-policies';
import { subagentModelCatalogSchema } from './subagent-model-catalog';

export const sessionMetadataSchema = z
  .object({
    sessionId: z.string().min(1),
    claudeSessionId: z.string().min(1),
    workingDirectory: z.string().min(1),
    createdAt: z.string().min(1),
    lastActivity: z.string().min(1),
    systemPrompt: z.string().optional(),
    modelPromptHints: z.array(z.string()).optional(),
    availableEnvVars: z.array(z.string()).optional(),
    model: z.string().optional(),
    browserModel: z.string().optional(),
    dashboardBuilderModel: z.string().optional(),
    subagentModels: subagentModelCatalogSchema,
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
    sessionCapabilityGrants: z.array(z.enum(['subagents', 'workflows'])).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const persistedSessionsSchema = z.record(z.string(), sessionMetadataSchema);

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;
