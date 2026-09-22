import { FileTypeIcon } from './file-type-icon'
import { fileCategory, type FileCategory } from '@renderer/lib/file-types'
import { cn } from '@shared/lib/utils/cn'

/**
 * The 32px icon tile used by the delivered-file row: a neutral gray box with
 * the file's icon inside, its stroke colored by category. Six quiet hues cover
 * the categories that matter; archives, fonts, 3D, and unknown types stay
 * muted. Each entry is a light/dark pair so the hue holds in both themes. Only
 * this tile is colored — the bare icon at small sizes stays monochrome, since
 * a 1px stroke at 14px reads as a smudge, not a hue.
 */
const TINTS: Record<FileCategory, string> = {
  document: 'text-blue-700 dark:text-blue-300',
  text: 'text-blue-700 dark:text-blue-300',
  code: 'text-indigo-700 dark:text-indigo-300',
  data: 'text-indigo-700 dark:text-indigo-300',
  config: 'text-indigo-700 dark:text-indigo-300',
  shell: 'text-indigo-700 dark:text-indigo-300',
  spreadsheet: 'text-emerald-700 dark:text-emerald-300',
  presentation: 'text-orange-700 dark:text-orange-300',
  image: 'text-violet-700 dark:text-violet-300',
  video: 'text-pink-700 dark:text-pink-300',
  audio: 'text-pink-700 dark:text-pink-300',
  archive: 'text-muted-foreground',
  font: 'text-muted-foreground',
  model: 'text-muted-foreground',
  other: 'text-muted-foreground',
}

const NEUTRAL = 'text-muted-foreground'

interface FileIconTileProps {
  filename: string
  folder?: boolean
  /** Apply the category tint; off gives the neutral gray box. */
  tinted?: boolean
  className?: string
}

export function FileIconTile({ filename, folder = false, tinted = true, className }: FileIconTileProps) {
  const tint = tinted && !folder ? TINTS[fileCategory(filename)] : NEUTRAL
  return (
    <div
      className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-black/5 bg-muted/50 dark:border-white/5', tint, className)}
      // Reports the hue that was actually applied, not the prop: folders and
      // the categories that map to NEUTRAL render untinted whatever is asked.
      data-tinted={tint !== NEUTRAL || undefined}
    >
      {/* The icon inherits the tile's color, so the stroke takes the hue. */}
      <FileTypeIcon filename={filename} size="lg" folder={folder} />
    </div>
  )
}
