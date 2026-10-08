import { EXPORT_FORMATS, FOLDER_MIME_TYPE, SHORTCUT_MIME_TYPE, type DriveFile, type ExportFormat } from './google-drive-schema'

/** One entry as the agent sees it: its shown name, the raw Drive file to act on, and the export it reads as. */
export interface VisibleEntry {
  name: string
  file: DriveFile
  format: ExportFormat | null
}

const GOOGLE_TYPE_PREFIX = 'application/vnd.google-apps.'

export function isExport(entry: VisibleEntry): entry is VisibleEntry & { format: ExportFormat } {
  return entry.format !== null
}

export function isFolder(file: DriveFile): boolean {
  return file.mimeType === FOLDER_MIME_TYPE
}

/** The entries a folder shows for its raw children. Every naming rule lives here, in
 * this order: hide what cannot be served, map `/`, add export extensions, suffix an
 * export that clashes with a real entry, and keep the newest of a name used twice. */
export function folderView(children: DriveFile[], tooLarge: (file: DriveFile) => boolean): { entries: VisibleEntry[]; warnings: string[] } {
  const warnings: string[] = []
  const named: VisibleEntry[] = []
  for (const file of children) {
    if (file.trashed) continue
    if (file.mimeType === SHORTCUT_MIME_TYPE) { warnings.push(`hiding shortcut ${file.name} (${file.id})`); continue }
    if (!isFolder(file) && file.capabilities?.canDownload === false) { warnings.push(`hiding ${file.name} (${file.id}): downloads are blocked`); continue }
    const format = EXPORT_FORMATS[file.mimeType] ?? null
    if (!format && !isFolder(file) && file.mimeType.startsWith(GOOGLE_TYPE_PREFIX)) continue
    if (format && tooLarge(file)) { warnings.push(`hiding ${file.name} (${file.id}): its export exceeds 10 MB`); continue }
    if (file.name === '.' || file.name === '..') { warnings.push(`hiding an entry named ${file.name} (${file.id})`); continue }
    const shown = file.name.replaceAll('/', '／')
    named.push({ name: format ? shown + format.extension : shown, file, format })
  }
  const real = new Set(named.filter(entry => !entry.format).map(entry => entry.name))
  for (const entry of named) {
    if (entry.format && real.has(entry.name)) {
      // A real file can hold the suffixed name too (an agent saved over the copy). The ID keeps the Google
      // file visible under a name that only changes when that name is taken as well.
      const { label, extension } = entry.format
      const base = entry.name.slice(0, -extension.length)
      const candidates = [`(${label})`, `(${label} ${entry.file.id.slice(0, 5)})`, `(${label} ${entry.file.id})`]
      entry.name = candidates.map(suffix => `${base} ${suffix}${extension}`).find(name => !real.has(name)) ?? `${base} (${label} ${entry.file.id})${extension}`
    }
  }
  const newest = new Map<string, VisibleEntry>()
  for (const entry of named) {
    const current = newest.get(entry.name)
    if (!current || Date.parse(entry.file.modifiedTime) > Date.parse(current.file.modifiedTime)) newest.set(entry.name, entry)
  }
  const kept = new Set(newest.values())
  for (const entry of named) if (!kept.has(entry)) warnings.push(`hiding ${entry.name} (${entry.file.id}): another entry of that name was modified later`)
  return { entries: named.filter(entry => kept.has(entry)), warnings }
}

export type WriteTarget = { kind: 'update'; id: string; convertFrom?: string } | { kind: 'create' } | { kind: 'refused' }

/** Where a write of `name` lands: a visible file is replaced, a Google file's copy is converted back
 * into that Google file, a visible folder is refused, and any other name makes a new file. */
export function writeTarget(entries: VisibleEntry[], name: string): WriteTarget {
  const visible = entries.find(entry => entry.name === name)
  if (!visible) return { kind: 'create' }
  if (visible.format) return { kind: 'update', id: visible.file.id, convertFrom: visible.format.mimeType }
  return isFolder(visible.file) ? { kind: 'refused' } : { kind: 'update', id: visible.file.id }
}

/** Whether an entry named `driveName` in Drive and shown as `shownName` would clash with
 * any raw child or shown entry, other than the entry `except` itself. */
export function nameTaken(children: DriveFile[], entries: VisibleEntry[], driveName: string, shownName = driveName, except?: string): boolean {
  return children.some(file => file.id !== except && file.name === driveName)
    || entries.some(entry => entry.file.id !== except && entry.name === shownName)
}

/** The Drive name an entry gets when renamed to `name`: an export sheds its clash suffix
 * and extension, which the new name must keep. Null when it does not. */
export function driveNameOf(entry: VisibleEntry, name: string): string | null {
  if (!entry.format) return name
  const { extension, label } = entry.format
  if (name.length <= extension.length || !name.endsWith(extension)) return null
  const base = name.slice(0, -extension.length)
  for (const suffix of [` (${label})`, ` (${label} ${entry.file.id.slice(0, 5)})`, ` (${label} ${entry.file.id})`]) {
    if (base.endsWith(suffix) && base.length > suffix.length) return base.slice(0, -suffix.length)
  }
  return base
}
