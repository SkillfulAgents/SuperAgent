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
import { fileCategory, type FileCategory } from '@renderer/lib/file-types'
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

/** Height/width pairs rather than `size-*`, so a caller's `className` can override either axis. */
const SIZE_CLASS: Record<FileTypeIconSize, string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
  lg: 'h-5 w-5',
  xl: 'h-6 w-6',
}

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
 *
 * The glyph takes its color from whatever it sits in, so it brightens with a
 * row on hover and turns red inside an error line. Callers that want it quieter
 * than their text pass `text-muted-foreground` themselves.
 */
export function FileTypeIcon({ filename, size = 'sm', folder = false, className }: FileTypeIconProps) {
  const category = folder ? null : fileCategory(filename)
  const Icon = category === null ? Folder : CATEGORY_ICONS[category]

  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center', SIZE_CLASS[size], className)}
      data-file-icon-size={size}
      data-file-category={category ?? undefined}
      aria-hidden="true"
    >
      <Icon className="h-full w-full" strokeWidth={1} />
    </span>
  )
}
