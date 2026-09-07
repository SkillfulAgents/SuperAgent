import { z } from 'zod'

// The subset of vitest's `json` reporter output (jest-compatible shape) that the
// CI failure summary reads back. Unknown keys are stripped, not rejected, so a
// vitest upgrade that adds fields does not break the summary step.
export const vitestAssertionResultSchema = z.object({
  ancestorTitles: z.array(z.string()).default([]),
  fullName: z.string().default(''),
  title: z.string().default(''),
  status: z.string(),
  duration: z.number().nullish(),
  failureMessages: z.array(z.string()).default([]),
  location: z
    .object({
      line: z.number(),
      column: z.number(),
    })
    .nullish(),
})

export const vitestFileResultSchema = z.object({
  name: z.string(),
  status: z.string(),
  // Set when the file itself blew up (an import threw, a top-level hook failed)
  // and no assertion ever ran.
  message: z.string().default(''),
  assertionResults: z.array(vitestAssertionResultSchema).default([]),
})

export const vitestReportSchema = z.object({
  success: z.boolean().default(false),
  numTotalTests: z.number().default(0),
  numPassedTests: z.number().default(0),
  numFailedTests: z.number().default(0),
  numPendingTests: z.number().default(0),
  numTotalTestSuites: z.number().default(0),
  testResults: z.array(vitestFileResultSchema).default([]),
})

export type VitestAssertionResult = z.infer<typeof vitestAssertionResultSchema>
export type VitestFileResult = z.infer<typeof vitestFileResultSchema>
export type VitestReport = z.infer<typeof vitestReportSchema>
