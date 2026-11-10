/**
 * Trigger a browser file download from a fetch Response.
 *
 * The server's Content-Disposition filename wins when present so the naming
 * convention (including branded extensions like .agent/.skill) lives in one
 * place; `fallbackFilename` covers responses without the header.
 */
export async function downloadBlob(res: Response, fallbackFilename: string): Promise<void> {
  saveBlob(await res.blob(), filenameFromContentDisposition(res.headers.get('content-disposition')) ?? fallbackFilename)
}

/** Trigger a browser file download of a blob made in the page. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null
  // Prefer the RFC 5987 form over the quoted fallback; the API percent-encodes
  // both (see packageDownloadResponse / workspace-file downloads), so decode.
  const encoded =
    header.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? header.match(/filename="([^"]+)"/i)?.[1]
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    // Not percent-encoded (a stray `%` would throw) — use it verbatim.
    return encoded
  }
}
