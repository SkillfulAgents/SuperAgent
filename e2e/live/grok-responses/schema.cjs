const { z } = require('/app/node_modules/zod')
exports.packageMetadata = z.object({ version: z.string() })
exports.fetchInput = z.object({ url: z.url(), maxChars: z.number().int().positive().optional() })
exports.reportSchema = z.object({
  sessionId: z.string(), sdkVersion: z.string(),
  cases: z.array(z.object({ name: z.string(), text: z.string(), textDeltas: z.number(), thinkingDeltas: z.number(),
    calls: z.array(z.object({ id: z.string(), name: z.string(), input: z.unknown(), messageId: z.string() })),
    toolErrors: z.array(z.string()), streamErrors: z.array(z.string()), result: z.unknown(),
  })),
  directImage: z.object({ text: z.string(), textDeltas: z.number() }),
  upstream: z.object({ responses: z.number(), messages: z.number(), images: z.number(), toolResults: z.number() }),
  fetchedPages: z.array(z.string()),
})
