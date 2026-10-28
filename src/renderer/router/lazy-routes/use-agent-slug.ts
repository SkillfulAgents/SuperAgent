import { useParams } from '@tanstack/react-router'

/** Read the parent agent slug from any lazy agent leaf route. */
export function useAgentSlug(): string | null {
  return (useParams({ strict: false }) as { slug?: string }).slug ?? null
}
