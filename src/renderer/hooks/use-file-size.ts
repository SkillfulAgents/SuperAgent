import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'

/**
 * Byte size of a workspace file, read from the Content-Length of a HEAD
 * request against its API path. The file route answers HEAD with the same
 * headers as GET, so this never downloads the body. `version` is the tab's
 * cache-busting token: a redelivered file gets a fresh size.
 */
export function useFileSize(fileApiPath: string | null, version = 0) {
  return useQuery<number | null>({
    queryKey: ['file-size', fileApiPath, version],
    queryFn: async () => {
      const res = await apiFetch(`${fileApiPath}?v=${version}`, { method: 'HEAD' })
      if (!res.ok) return null
      const length = res.headers.get('content-length')
      const bytes = length === null ? NaN : Number(length)
      return Number.isFinite(bytes) ? bytes : null
    },
    enabled: fileApiPath !== null,
    staleTime: 60_000,
    retry: false,
  })
}
