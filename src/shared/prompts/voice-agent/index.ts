// Vite ?raw imports bundle the file content as strings at build time
import createAgentPrompt from './create-agent.md?raw'
import improveAgentPrompt from './improve-agent.md?raw'

const prompts = {
  'create-agent': createAgentPrompt,
  'improve-agent': improveAgentPrompt,
} as const

export type VoiceAgentPromptName = keyof typeof prompts

export function getVoiceAgentPrompt(name: VoiceAgentPromptName): string {
  const prompt = prompts[name]
  if (!prompt) {
    throw new Error(`Unknown voice agent prompt: ${name}`)
  }
  return prompt
}
