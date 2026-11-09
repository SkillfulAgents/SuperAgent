import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import type {
  DirectoryInstallStatus, RefreshDirectoryResponse, StartDirectoryInstallResponse, TeamDirectoriesResponse, TeamDirectoryView,
} from '@shared/lib/team-directory/view-schema'

const QUERY_KEY = ['team-directories']

export interface DirectoryCredentialsInput {
  provider: string
  credentials: Record<string, string>
}

async function json<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error ?? fallback)
  return body as T
}

const post = (path: string, body: unknown) => apiFetch(`/api/team-directories${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export function useTeamDirectories() {
  return useQuery<TeamDirectoriesResponse>({
    queryKey: QUERY_KEY,
    queryFn: async () => json(await apiFetch('/api/team-directories'), 'Could not load team directories'),
  })
}

export function useTestDirectoryCredentials() {
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (input: DirectoryCredentialsInput) => json<{ tenantName: string; notices?: string[] }>(await post('/test', input), 'Could not check these credentials'),
  })
}

export function useConnectTeamDirectory() {
  const client = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (input: DirectoryCredentialsInput) => json<{ directory: TeamDirectoryView; notices?: string[] }>(await post('', input), 'Could not connect the directory'),
    onSuccess: () => client.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useRefreshTeamDirectory() {
  const client = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (id: string) => json<RefreshDirectoryResponse>(await post(`/${encodeURIComponent(id)}/refresh`, {}), 'Could not check the directory'),
    onSuccess: () => client.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useDisconnectTeamDirectory() {
  const client = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (id: string) => {
      const response = await apiFetch(`/api/team-directories/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!response.ok) await json(response, 'Could not disconnect the directory')
    },
    onSuccess: () => client.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

/** Connects a directory with its app-creation credentials alone: Gamut creates its app; the result is the page that installs it. */
export function useStartDirectoryInstall() {
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (input: DirectoryCredentialsInput) => json<StartDirectoryInstallResponse>(await post('/install', input), 'Could not create the app'),
  })
}

/** How a started install went; polled while a person is on the provider's page. */
export function useDirectoryInstallStatus(installId: string | null, poll: boolean) {
  return useQuery<DirectoryInstallStatus>({
    queryKey: [...QUERY_KEY, 'install', installId],
    enabled: installId !== null,
    refetchInterval: poll ? 1500 : false,
    queryFn: async () => json(await apiFetch(`/api/team-directories/install/${encodeURIComponent(installId ?? '')}`), 'Could not check the install'),
  })
}

/** Adds or replaces the credentials that let a directory create agents' apps. */
export function useConnectProvisioning() {
  const client = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ id, credentials }: { id: string; credentials: Record<string, string> }) =>
      json<{ directory: TeamDirectoryView }>(await post(`/${encodeURIComponent(id)}/provisioning`, { credentials }), 'Could not save the credentials'),
    onSuccess: () => client.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}

export function useDisconnectProvisioning() {
  const client = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (id: string) => {
      const response = await apiFetch(`/api/team-directories/${encodeURIComponent(id)}/provisioning`, { method: 'DELETE' })
      if (!response.ok) await json(response, 'Could not stop creating apps')
    },
    onSuccess: () => client.invalidateQueries({ queryKey: QUERY_KEY }),
  })
}
