import { z } from 'zod'

const packedSkillsetFileSchema = z.object({
  path: z.string().min(1).refine((value) => value.split('/').every(
    (part) => part !== '' && part !== '.' && part !== '..' && !/[\\\0:]/.test(part),
  ), 'Expected a relative file path'),
  data: z.string().base64(),
  mode: z.number().int().min(0).max(0o777),
})

export const skillsetCacheBlobSchema = z.object({
  v: z.literal(1),
  version: z.string().uuid(),
  files: z.array(packedSkillsetFileSchema),
})

export type PackedSkillsetFile = z.infer<typeof packedSkillsetFileSchema>
