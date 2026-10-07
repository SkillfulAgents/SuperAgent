import { z } from 'zod'

export const folderPickerQuerySchema = z.object({
  path: z.string().min(1).refine(value => !value.includes('\0')).optional(),
})

const folderSchema = z.object({ name: z.string(), path: z.string() })

export const folderPickerListingSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  folders: z.array(folderSchema),
  locations: z.array(folderSchema),
})

export type FolderPickerListing = z.infer<typeof folderPickerListingSchema>
