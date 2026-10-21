const { z } = require('zod')

const asarEntrySchema = z.lazy(() => z.object({
  files: z.record(z.string(), asarEntrySchema).optional(),
  size: z.number().int().nonnegative().optional(),
  unpacked: z.boolean().optional(),
}))

const packageSchema = z.object({
  name: z.string(),
  version: z.string(),
  main: z.string().optional(),
  build: z.object({}).passthrough().optional(),
}).passthrough()

module.exports = { asarEntrySchema, packageSchema }
