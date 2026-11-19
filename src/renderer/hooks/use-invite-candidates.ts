import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import type { InviteCandidate } from '@shared/lib/team-directory/candidate-schema'

export type ShareTarget = { kind: 'agent' | 'drive'; id: string }

export function accessUrl({ kind, id }: ShareTarget) {
  return `/api/${kind === 'agent' ? 'agents' : 'volume-definitions'}/${encodeURIComponent(id)}/access`
}

export function useInviteCandidates(target: ShareTarget, query: string, enabled: boolean) {
  const [searched, setSearched] = useState(query.trim())
  useEffect(() => {
    const timer = setTimeout(() => setSearched(query.trim()), 200)
    return () => clearTimeout(timer)
  }, [query])
  const key = target.kind === 'agent' ? 'agent-invite-candidates' : 'volume-owner-candidates'
  return useQuery<InviteCandidate[]>({
    queryKey: [key, target.id, searched],
    enabled,
    queryFn: async ({ signal }) => {
      const suffix = searched ? `?q=${encodeURIComponent(searched)}` : ''
      const response = await apiFetch(`${accessUrl(target)}/search-users${suffix}`, { signal })
      if (!response.ok) throw new Error('Could not load people')
      return response.json()
    },
    // Keep suggestions while typing, only within the same authorized resource.
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[0] === key && previousQuery.queryKey[1] === target.id ? previous : undefined,
  })
}
