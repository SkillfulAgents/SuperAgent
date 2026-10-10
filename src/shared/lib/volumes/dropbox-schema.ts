import { z } from 'zod'

/** Dropbox paths are relative to the account's home namespace. '' names its root. */
export const dropboxPathSchema = z.string().max(2000)
  .transform(value => value === '/' ? '' : value.replace(/\/$/, ''))
  .refine(value => value === '' || (value.startsWith('/') && value.slice(1).split('/').every(
    part => part !== '' && part !== '.' && part !== '..' && !/[\\\0]/.test(part),
  )), 'Select a Dropbox folder')

export const dropboxVolumeConfigSchema = z.object({
  accountId: z.string().min(1),
  path: dropboxPathSchema,
}).strict()
export type DropboxVolumeConfig = z.infer<typeof dropboxVolumeConfigSchema>

const nameSchema = z.string().min(1).refine(name => name !== '.' && name !== '..' && !/[/\\\0]/.test(name))
export const dropboxMetadataSchema = z.discriminatedUnion('.tag', [
  z.object({ '.tag': z.literal('folder'), name: nameSchema, id: z.string(), path_display: z.string().optional() }),
  z.object({
    '.tag': z.literal('file'), name: nameSchema, id: z.string(), size: z.number().int().nonnegative(),
    rev: z.string().min(1), server_modified: z.iso.datetime(), is_downloadable: z.boolean().optional(),
    symlink_info: z.unknown().optional(),
  }),
])
export type DropboxMetadata = z.infer<typeof dropboxMetadataSchema>
// Continuations can report deletions made during pagination even when the
// initial list_folder request specifies include_deleted: false.
const dropboxDeletedMetadataSchema = z.object({ '.tag': z.literal('deleted'), name: nameSchema })
export const dropboxListSchema = z.object({
  entries: z.array(z.union([dropboxMetadataSchema, dropboxDeletedMetadataSchema])), cursor: z.string(), has_more: z.boolean(),
})
export type DropboxList = z.infer<typeof dropboxListSchema>
export const dropboxSessionSchema = z.object({ session_id: z.string().min(1) })
export const dropboxErrorSchema = z.object({
  error_summary: z.string().optional(),
  error: z.object({
    '.tag': z.string().optional(),
    reason: z.object({ '.tag': z.string() }).optional(),
    retry_after: z.number().nonnegative().optional(),
  }).optional(),
})
export const dropboxBrowseSchema = dropboxVolumeConfigSchema
export const dropboxFoldersSchema = z.object({
  folders: z.array(z.object({ name: nameSchema, path: dropboxPathSchema })),
})
export type DropboxFolders = z.infer<typeof dropboxFoldersSchema>
