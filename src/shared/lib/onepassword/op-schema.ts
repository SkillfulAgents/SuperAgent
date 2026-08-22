import { z } from 'zod'

/**
 * Zod boundary for `op` CLI output.
 *
 * Reader-lenient by design: item shapes vary by age and category, and one
 * malformed entry must not discard the whole vault. Follows the project's
 * reader-lenient / writer-strict convention — nothing here is ever written
 * back to 1Password.
 */

export const opUrlSchema = z.object({
  href: z.string(),
  primary: z.boolean().optional(),
})

export const opFieldSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  type: z.string().optional(),
  value: z.string().optional(),
})

export const opLoginItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(''),
  category: z.string().optional(),
  urls: z.array(opUrlSchema).default([]),
  fields: z.array(opFieldSchema).default([]),
  additional_information: z.string().optional(),
})

export const opAccountSchema = z.object({
  account_uuid: z.string().min(1),
}).passthrough()

export const opFieldOutputSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  value: z.string().optional(),
})

export type OpLoginItem = z.infer<typeof opLoginItemSchema>
export type OpUrl = z.infer<typeof opUrlSchema>
export type OpAccount = z.infer<typeof opAccountSchema>
export type OpFieldOutput = z.infer<typeof opFieldOutputSchema>

export function parseAccounts(raw: unknown): OpAccount[] {
  if (!Array.isArray(raw)) return []
  const out: OpAccount[] = []
  for (const entry of raw) {
    const parsed = opAccountSchema.safeParse(entry)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

export function parseFieldOutput(raw: unknown): { username: string; password: string | null } {
  if (raw === null || (typeof raw !== 'object' && !Array.isArray(raw))) {
    throw new Error('malformed field output')
  }
  const entries = Array.isArray(raw) ? raw : [raw]
  const fields: OpFieldOutput[] = []
  for (const entry of entries) {
    const parsed = opFieldOutputSchema.safeParse(entry)
    if (parsed.success) fields.push(parsed.data)
  }

  const byKey = (key: 'username' | 'password') =>
    fields.find((field) => field.label === key || field.id === key)

  const username = byKey('username')?.value
  const password = byKey('password')?.value
  return {
    username: username ?? '',
    password: password === undefined ? null : password,
  }
}

/** Keep every item that parses, drop the ones that do not. */
export function parseLoginItems(raw: unknown[]): OpLoginItem[] {
  const out: OpLoginItem[] = []
  for (const entry of raw) {
    const parsed = opLoginItemSchema.safeParse(entry)
    if (!parsed.success) continue
    out.push({
      ...parsed.data,
      fields: parsed.data.fields.map((field) => {
        const isUsername = field.id === 'username' || field.label === 'username'
        if (isUsername) return field
        const next = { ...field }
        delete next.value
        return next
      }),
    })
  }
  return out
}

/**
 * The item's username. Not a secret — `op` returns usernames in plain output
 * and conceals only password and OTP fields.
 */
export function usernameOf(item: OpLoginItem): string | null {
  const field = item.fields.find((f) => f.id === 'username' || f.label === 'username')
  if (field?.value) return field.value
  const listed = item.additional_information?.trim()
  return listed || null
}
