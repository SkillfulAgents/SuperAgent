import { apiFetch } from '@renderer/lib/api'

const FALLBACK_NAME = 'New Agent'

export function fallbackNameFromPrompt(prompt: string): string {
  return prompt.trim().split(/\s+/).slice(0, 5).join(' ').slice(0, 50)
}

export async function deriveAgentName(prompt: string): Promise<string> {
  try {
    const res = await apiFetch('/api/agents/generate-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt.trim() }),
    })
    if (res.ok) {
      const data = (await res.json()) as { name?: string }
      const generated = data.name?.trim() ?? ''
      if (generated) return generated
    }
  } catch {
    // fall through
  }
  return fallbackNameFromPrompt(prompt) || FALLBACK_NAME
}
