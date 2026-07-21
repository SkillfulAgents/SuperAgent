import { z } from 'zod'
import path from 'path'

function isWorkspaceFolderPath(folderPath: string): boolean {
  if (!folderPath.startsWith('/') || folderPath.includes('\0')) return false
  const normalized = path.posix.normalize(folderPath)
  return normalized === '/workspace' || normalized.startsWith('/workspace/')
}

export const bookmarkSchema = z.object({
  name: z.string().min(1, 'Bookmark name is required'),
  link: z.string().url('Link must be a valid URL starting with https://').startsWith('https://', 'Link must start with https://').optional(),
  file: z.string().min(1, 'File path must not be empty').optional(),
  folder: z.string()
    .min(1, 'Folder path must not be empty')
    .refine(
      isWorkspaceFolderPath,
      'Folder path must be inside /workspace',
    )
    .optional(),
}).refine(
  (bookmark) => [bookmark.link, bookmark.file, bookmark.folder].filter((value) => value != null).length === 1,
  { message: 'Each bookmark must have exactly one of "link", "file", or "folder"' }
)

export const bookmarksSchema = z.array(bookmarkSchema)

export type Bookmark = z.infer<typeof bookmarkSchema>
