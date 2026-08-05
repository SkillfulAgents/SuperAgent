import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

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

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

export function subagentTypeForModel(model: SubagentModelDefinition): string {
  const slug =
    model.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'custom';
  return `model-${slug}-${stableHash(model.id)}`;
}

function modelDescription(model: SubagentModelDefinition): string {
  const details = [
    model.blurb,
    model.family && model.isLatest ? `Latest ${model.family} model.` : undefined,
    model.contextWindow ? `${model.contextWindow.toLocaleString('en-US')}-token context window.` : undefined,
    model.pricing
      ? `$${model.pricing.inputPerMtok}/$${model.pricing.outputPerMtok} per million input/output tokens.`
      : undefined,
    model.supportsWebSearch === false ? 'No native web search.' : undefined,
    model.supportsWebFetch === false ? 'No native web fetch.' : undefined,
    model.supportsImageInput === true ? 'Accepts image input.' : undefined,
  ].filter(Boolean);

  return `General-purpose subagent using exact model ID "${model.id}" (${model.label}). ${details.join(' ')}`.trim();
}

function modelPrompt(model: SubagentModelDefinition): string {
  const hints = model.promptHints?.length
    ? `\n\nModel-specific operating guidance:\n${model.promptHints.map((hint) => `- ${hint}`).join('\n')}`
    : '';
  return `Complete the delegated task independently using the exact model configured for this subagent. Return a concise result with relevant evidence. Do not delegate the task to another agent.${hints}`;
}

function directToolsForModel(model: SubagentModelDefinition): string[] {
  const tools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];
  if (model.supportsWebSearch !== false) tools.push('WebSearch');
  if ((model.supportsWebFetch ?? model.supportsWebSearch) !== false) tools.push('WebFetch');
  return tools;
}

export function buildModelSubagentDefinitions(
  models: SubagentModelDefinition[],
): Record<string, AgentDefinition> {
  return Object.fromEntries(
    models.map((model) => [
      subagentTypeForModel(model),
      {
        description: modelDescription(model),
        model: model.id,
        prompt: modelPrompt(model),
        tools: directToolsForModel(model),
      },
    ]),
  );
}
