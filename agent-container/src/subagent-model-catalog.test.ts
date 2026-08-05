import { describe, expect, it } from 'vitest';
import {
  buildModelSubagentDefinitions,
  subagentModelCatalogSchema,
  subagentTypeForModel,
} from './subagent-model-catalog';

describe('model-backed subagents', () => {
  const models = subagentModelCatalogSchema.parse([
    {
      id: 'openai/gpt-5.5',
      label: 'GPT 5.5',
      family: 'gpt',
      isLatest: true,
      promptHints: ['Use the available tools instead of describing hypothetical calls.'],
      supportsWebSearch: false,
      pricing: { inputPerMtok: 5, outputPerMtok: 30 },
      contextWindow: 400_000,
    },
    {
      id: 'anthropic/claude-sonnet-5',
      label: 'Sonnet 5',
    },
  ]);

  it('builds deterministic, collision-safe subagent types with exact model ids', () => {
    const definitions = buildModelSubagentDefinitions(models);
    const gptType = subagentTypeForModel(models[0]);
    const sonnetType = subagentTypeForModel(models[1]);

    expect(gptType).toMatch(/^model-gpt-5-5-[a-z0-9]{7}$/);
    expect(subagentTypeForModel(models[0])).toBe(gptType);
    expect(sonnetType).not.toBe(gptType);
    expect(definitions[gptType].model).toBe('openai/gpt-5.5');
    expect(definitions[gptType].description).toContain('exact model ID "openai/gpt-5.5"');
    expect(definitions[gptType].description).toContain('400,000-token context window');
    expect(definitions[gptType].prompt).toContain(models[0].promptHints![0]);
    expect(definitions[gptType].tools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']);
    expect(definitions[sonnetType].tools).toContain('WebSearch');
    expect(definitions[sonnetType].tools).toContain('WebFetch');
  });

  it('rejects malformed or oversized catalogs at the container boundary', () => {
    expect(() => subagentModelCatalogSchema.parse([{ id: '', label: 'Broken' }])).toThrow();
    expect(() =>
      subagentModelCatalogSchema.parse(
        Array.from({ length: 33 }, (_, index) => ({
          id: `model-${index}`,
          label: `Model ${index}`,
        })),
      ),
    ).toThrow();
  });
});
