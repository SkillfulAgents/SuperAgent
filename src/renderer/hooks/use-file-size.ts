import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'

interface UseFileSizeOptions {
  /** The bytes at this path can never change, so the answer never expires. */
  immutable?: boolean
}

/**
 * Byte size of a workspace file, read from the Content-Length of a HEAD
 * request against its API path. The file route answers a HEAD with the same
 * headers as a GET and no body, and the cloud proxy passes that length through
 * rather than stripping it as it does for a re-framed body — so this costs one
 * round trip and no bytes, in either mode. `version` is the tab's cache-busting
 * token: a redelivered file gets a fresh size.
 */
export function useFileSize(fileApiPath: string | null, version = 0, options?: UseFileSizeOptions) {
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
    // A workspace file the agent can rewrite is only trusted for a minute;
    // one at a path that is never reused (an upload, stamped with the
    // millisecond it arrived) never needs asking twice.
    staleTime: options?.immutable ? Infinity : 60_000,
    retry: false,
  })
}
