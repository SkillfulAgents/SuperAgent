import {
  File,
  FileArchive,
  FileAxis3d,
  FileBraces,
  FileChartLine,
  FileCode,
  FileImage,
  FilePlay,
  FileSliders,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  Folder,
  type LucideIcon,
} from 'lucide-react'
import { fileCategory, type FileCategory } from '@renderer/components/file-preview/file-types'
import { cn } from '@shared/lib/utils/cn'

/**
 * One icon scale per text context, so file glyphs line up the same way
 * everywhere they appear next to a name:
 *
 * - `sm` (14px): inline with text-xs — pills, tabs, menu rows, dense lists
 * - `md` (16px): single-line rows with text-xs/sm — bookmarks, tool detail
 * - `lg` (20px): inside a 32px tile — the delivered-file row
 * - `xl` (24px): two-line cards with a name and a metadata line
 *
 * Lucide's page spans 20 of the 24 viewBox units, so the drawn page is about
 * five-sixths of the token: 20px renders a ~16px page.
 */
export type FileTypeIconSize = 'sm' | 'md' | 'lg' | 'xl'

const SIZE_PX: Record<FileTypeIconSize, number> = { sm: 14, md: 16, lg: 20, xl: 24 }

/**
 * Lucide `file-*` icon per category. All but file-archive draw the glyph
 * centered inside the same page outline; archive is the one corner-style
 * outlier, accepted because zips are an outlier as a file type anyway.
 * Categories without an entry fall back to the plain `file` page.
 */
const CATEGORY_ICONS: Record<FileCategory, LucideIcon> = {
  document: FileText,
  text: FileText,
  code: FileCode,
  data: FileBraces,
  config: FileSliders,
  shell: FileTerminal,
  spreadsheet: FileSpreadsheet,
  presentation: FileChartLine,
  image: FileImage,
  video: FilePlay,
  audio: FilePlay,
  archive: FileArchive,
  font: FileType,
  model: FileAxis3d,
  other: File,
}

/** Lowercase extension, or '' for dotless names (unlike the shared mime helper). */
export function getExtension(filename: string): string {
  const parts = filename.split('.')
  if (parts.length < 2) return ''
  return parts.pop()!.toLowerCase()
}

interface FileTypeIconProps {
  filename: string
  size?: FileTypeIconSize
  /** Render the folder glyph in the same box, so folder and file rows align. */
  folder?: boolean
  className?: string
}

/**
 * File-type icon in a fixed square box: the lucide `file-*` icon for the
 * file's category, plain `file` when the category has none, or the lucide
 * folder glyph. Everything is drawn at stroke width 1, so all three share an
 * outline weight and scale together with the size token.
 */
export function FileTypeIcon({ filename, size = 'sm', folder = false, className }: FileTypeIconProps) {
  const px = SIZE_PX[size]
  const ext = getExtension(filename)
  const category = folder ? undefined : fileCategory(filename)
  const Icon = folder ? Folder : CATEGORY_ICONS[category ?? 'other']

  return (
    <span
      style={{ width: px, height: px }}
      className={cn('inline-flex shrink-0 items-center justify-center text-muted-foreground', className)}
      data-file-icon-size={size}
      data-file-ext={folder ? undefined : ext || undefined}
      data-file-category={category}
      aria-hidden="true"
    >
      <Icon className="h-full w-full" strokeWidth={1} />
    </span>
  )
}
