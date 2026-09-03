import { useQuery } from '@tanstack/react-query'
import { getApiBaseUrl } from '@renderer/lib/env'
import {
  fallbackWorkspaceFilePath,
  getAgentFileApiPath,
} from '@renderer/lib/workspace-file-url'

function withVersion(url: string, inline: boolean, versionQuery: string): string {
  if (inline && versionQuery) return `${url}?inline=true&${versionQuery}`
  if (inline) return `${url}?inline=true`
  if (versionQuery) return `${url}?${versionQuery}`
  return url
}

export function usePreviewFileSource(
  agentSlug: string,
  filePath: string,
  version: number,
): {
  filePath: string
  fileUrl: string | null
  downloadUrl: string | null
  isResolving: boolean
} {
  const fallbackPath = fallbackWorkspaceFilePath(filePath)
  const primaryApiPath = getAgentFileApiPath(agentSlug, filePath)
  const fallbackApiPath = fallbackPath ? getAgentFileApiPath(agentSlug, fallbackPath) : null
  const baseUrl = getApiBaseUrl()
  const versionQuery = version > 0 ? `v=${version}` : ''
  const primaryUrl = primaryApiPath
    ? withVersion(`${baseUrl}${primaryApiPath}`, true, versionQuery)
    : null

  const probe = useQuery({
    queryKey: ['file-preview-probe', primaryUrl],
    queryFn: async () => {
      const res = await fetch(primaryUrl!)
      return res.status
    },
    enabled: Boolean(primaryUrl && fallbackPath && fallbackApiPath),
    staleTime: 30_000,
  })

  const useFallback = probe.data === 404 && fallbackPath && fallbackApiPath
  const resolvedPath = useFallback ? fallbackPath : filePath
  const resolvedApiPath = useFallback ? fallbackApiPath : primaryApiPath
  const fileUrl = resolvedApiPath
    ? withVersion(`${baseUrl}${resolvedApiPath}`, true, versionQuery)
    : null
  const downloadUrl = resolvedApiPath
    ? withVersion(`${baseUrl}${resolvedApiPath}`, false, versionQuery)
    : null

  return {
    filePath: resolvedPath,
    fileUrl,
    downloadUrl,
    isResolving: Boolean(fallbackPath && fallbackApiPath && probe.isPending),
  }
}
