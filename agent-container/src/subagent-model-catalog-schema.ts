import { z } from 'zod';

// Keep in sync with src/shared/lib/container/subagent-model-catalog.ts. The
// container package cannot import the host application's @shared modules.
export const MAX_SUBAGENT_MODELS = 32;

export const subagentModelDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  blurb: z.string().optional(),
  family: z.string().optional(),
  isLatest: z.boolean().optional(),
  supportsWebSearch: z.boolean().optional(),
  supportsWebFetch: z.boolean().optional(),
  supportsImageInput: z.boolean().optional(),
  promptHints: z.array(z.string().min(1)).optional(),
  pricing: z
    .object({
      inputPerMtok: z.number().nonnegative(),
      outputPerMtok: z.number().nonnegative(),
    })
    .optional(),
  contextWindow: z.number().int().positive().optional(),
});

export const subagentModelCatalogSchema = z
  .array(subagentModelDefinitionSchema)
  .max(MAX_SUBAGENT_MODELS)
  .default([]);

export type SubagentModelDefinition = z.infer<typeof subagentModelDefinitionSchema>;

// Model id → catalog context window, host-supplied for every catalog model
// (subagentModels above only carries isLatest entries). Read at query build to
// set CLAUDE_CODE_MAX_CONTEXT_TOKENS; the SDK ignores it for claude-* models.
export const modelContextWindowsSchema = z
  .record(z.string().min(1), z.number().int().positive())
  .default({});

export type ModelContextWindows = z.infer<typeof modelContextWindowsSchema>;
