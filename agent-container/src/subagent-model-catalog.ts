import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { SubagentModelDefinition } from './subagent-model-catalog-schema';

// Preserve the existing catalog API while keeping data validation SDK-independent.
export * from './subagent-model-catalog-schema';

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

function directToolsForModel(
  model: SubagentModelDefinition,
  webSearchProvider?: string,
  webFetchProvider?: string,
): string[] {
  const tools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];
  if (webSearchProvider) {
    tools.push('mcp__web__web_search');
  } else if (model.supportsWebSearch !== false) {
    tools.push('WebSearch');
  }
  if (webFetchProvider) {
    tools.push('mcp__web__web_fetch');
  } else if ((model.supportsWebFetch ?? model.supportsWebSearch) !== false) {
    tools.push('WebFetch');
  }
  return tools;
}

export function buildModelSubagentDefinitions(
  models: SubagentModelDefinition[],
  webSearchProvider?: string,
  webFetchProvider?: string,
): Record<string, AgentDefinition> {
  return Object.fromEntries(
    models.map((model) => [
      subagentTypeForModel(model),
      {
        description: modelDescription(model),
        model: model.id,
        prompt: modelPrompt(model),
        tools: directToolsForModel(model, webSearchProvider, webFetchProvider),
      },
    ]),
  );
}
