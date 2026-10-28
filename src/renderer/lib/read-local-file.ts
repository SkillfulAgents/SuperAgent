/**
 * Read a file from disk via the preload bridge and wrap it as a DOM File —
 * MIME type included — for upload/attach flows. Returns null when the bridge
 * is unavailable (web build) or the main process refuses the path.
 */
export async function readLocalFileAsFile(filePath: string): Promise<File | null> {
  const result = await window.electronAPI?.readLocalFile?.(filePath)
  if (!result) return null
  return new File([result.buffer], result.name, { type: result.type })
}
