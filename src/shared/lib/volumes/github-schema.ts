import { z } from 'zod'

export const githubPathSchema = z.string().max(4096).refine(value => value === '' || value.split('/').every(
  part => part !== '' && part !== '.' && part !== '..' && !/[\\\0]/.test(part),
), 'Select a GitHub folder')
const nameSchema = z.string().min(1).refine(value => value !== '.' && value !== '..' && !/[/\\\0]/.test(value))
const branchSchema = z.string().min(1).max(1024).refine(value => [...value].every(char => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127))
export const githubOidSchema = z.string().regex(/^[0-9a-f]{40,64}$/)
export const githubVolumeConfigSchema = z.object({
  accountId: z.string().min(1), repoId: z.number().int().positive(), owner: nameSchema, repo: nameSchema,
  branch: branchSchema, path: githubPathSchema,
}).strict()
export type GithubVolumeConfig = z.infer<typeof githubVolumeConfigSchema>
export const githubBrowseSchema = z.object({
  accountId: z.string().min(1), repoId: z.coerce.number().int().positive().optional(),
  branch: branchSchema.optional(), path: githubPathSchema.optional(),
}).refine(value => !value.branch || value.repoId !== undefined, 'Select a repository first')
  .refine(value => value.path === undefined || value.branch !== undefined, 'Select a branch first')

export const githubRepoSchema = z.object({ id: z.number().int().positive(), name: nameSchema, owner: z.object({ login: nameSchema }) })
export const githubReposSchema = z.array(githubRepoSchema)
export const githubBranchesSchema = z.array(z.object({ name: branchSchema }))
export const githubErrorSchema = z.object({ message: z.string() })
export const githubHeadSchema = z.object({ object: z.object({ sha: githubOidSchema }) })
export const githubBlobSchema = z.object({ encoding: z.literal('base64'), content: z.string() })
export const githubTreeEntrySchema = z.object({
  path: githubPathSchema.refine(value => value !== ''), sha: githubOidSchema, mode: z.string(),
  type: z.enum(['blob', 'tree', 'commit']), size: z.number().int().nonnegative().optional(),
})
export type GithubTreeEntry = z.infer<typeof githubTreeEntrySchema>
export const githubTreeSchema = z.object({
  tree: z.array(githubTreeEntrySchema.extend({ path: z.string() }))
    .transform(entries => entries.filter(entry => !/[\\\0]/.test(entry.path)))
    .pipe(z.array(githubTreeEntrySchema)),
  truncated: z.boolean(),
})
const githubFileSchema = z.object({ sha: githubOidSchema, mode: z.string() })
export type GithubFile = z.infer<typeof githubFileSchema>
export const githubSyncStateSchema = z.object({
  version: z.literal(1), base: githubOidSchema.nullable(), files: z.record(githubPathSchema, githubFileSchema),
})
export type SyncState = z.infer<typeof githubSyncStateSchema>
export const githubCommitReplySchema = z.object({
  data: z.object({ createCommitOnBranch: z.object({ commit: z.object({ oid: githubOidSchema }).nullable() }).nullable() }).nullable().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
})

/** Paths the agent changed and GitHub does not have yet, conflicts it must resolve, and why pushes stopped. */
export const githubEditsSchema = z.object({
  version: z.literal(1),
  unpushed: z.record(z.string(), z.object({
    agents: z.array(z.string()), n: z.number().int(), sha: githubOidSchema.nullable(), group: z.string().optional(),
  })),
  held: z.record(z.string(), z.object({ reason: z.string(), behind: githubOidSchema.nullable().optional() })),
  stopped: z.string().nullable(),
  ignores: z.array(z.object({ dir: z.string(), sha: githubOidSchema })),
  links: z.array(z.string()).default([]),
})
export type GithubEdits = z.infer<typeof githubEditsSchema>
