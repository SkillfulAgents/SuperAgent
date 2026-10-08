import { z } from 'zod'

/** Drive IDs are opaque. The check keeps anything else out of queries built from them. */
export const driveIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Invalid Google Drive ID')

/** The folder's ID survives renames and moves; its name is read from Drive on save. */
export const googleDriveVolumeConfigSchema = z.object({
  accountId: z.string().min(1),
  folderId: driveIdSchema,
  folderName: z.string().min(1),
  driveName: z.string().min(1),
}).strict()
export type GoogleDriveVolumeConfig = z.infer<typeof googleDriveVolumeConfigSchema>

export const DRIVE_FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,trashed,capabilities(canDownload)'
export const driveFileSchema = z.object({
  id: driveIdSchema,
  name: z.string(),
  mimeType: z.string(),
  size: z.coerce.number().int().nonnegative().optional(),
  modifiedTime: z.iso.datetime(),
  trashed: z.boolean().optional(),
  capabilities: z.object({ canDownload: z.boolean().optional() }).optional(),
  driveId: driveIdSchema.optional(),
})
export type DriveFile = z.infer<typeof driveFileSchema>

export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'
export const SHORTCUT_MIME_TYPE = 'application/vnd.google-apps.shortcut'
export interface ExportFormat {
  mimeType: string
  extension: string
  label: string
}
/** What each Google type reads and saves as. Drive converts a saved copy back into the Google file, so every
 * format here round-trips. A Google type absent here (Forms, Drawings) cannot, and is hidden. */
export const EXPORT_FORMATS: Record<string, ExportFormat> = {
  'application/vnd.google-apps.document': { mimeType: 'text/markdown', extension: '.md', label: 'Google Doc' },
  'application/vnd.google-apps.spreadsheet': { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: '.xlsx', label: 'Google Sheet' },
  'application/vnd.google-apps.presentation': { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: '.pptx', label: 'Google Slides' },
}
export const driveFileSizeSchema = z.object({ size: z.coerce.number().int().nonnegative().optional() })
export const driveFileListSchema = z.object({ files: z.array(driveFileSchema), nextPageToken: z.string().optional() })
export const driveSchema = z.object({ id: driveIdSchema, name: z.string().min(1) })
export const driveListSchema = z.object({
  drives: z.array(driveSchema), nextPageToken: z.string().optional(),
})
export const driveErrorSchema = z.object({
  error: z.object({ errors: z.array(z.object({ reason: z.string().optional() })).optional() }).optional(),
})
export const googleDriveBrowseSchema = z.object({ accountId: z.string().min(1), folderId: driveIdSchema.optional() })
export const googleDriveFoldersSchema = z.object({ folders: z.array(z.object({ id: driveIdSchema, name: z.string() })) })
export type GoogleDriveFolders = z.infer<typeof googleDriveFoldersSchema>
