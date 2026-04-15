import { z } from 'zod'

export const bookmarkSchema = z.object({
  name: z.string().min(1, 'Bookmark name is required'),
  link: z.string().url('Link must be a valid URL starting with https://').startsWith('https://', 'Link must start with https://').optional(),
  file: z.string().min(1, 'File path must not be empty').optional(),
}).refine(
  (b) => (b.link != null) !== (b.file != null),
  { message: 'Each bookmark must have exactly one of "link" or "file", not both or neither' }
)

export const bookmarksSchema = z.array(bookmarkSchema)

export type Bookmark = z.infer<typeof bookmarkSchema>
