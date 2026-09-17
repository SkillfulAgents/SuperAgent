import { z } from 'zod'
const httpsUrl = z.string().url().refine(value => value.startsWith('https://'))
export const linearFileUploadSchema = z.object({ fileUpload: z.object({
  success: z.boolean(),
  uploadFile: z.object({ uploadUrl: httpsUrl, assetUrl: httpsUrl,
    headers: z.array(z.object({ key: z.string(), value: z.string() })),
  }).nullable(),
}) })
