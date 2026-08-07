import { generatedFileSchema, type CatalogCategory } from './replicate-schema'
import { WHITELIST_ENTRIES } from './whitelist-data'

const entries = generatedFileSchema.parse(WHITELIST_ENTRIES)
const MEMBERS = new Set(entries.map((e) => e.model))

export function isWhitelistedModel(owner: string, name: string): boolean {
  return MEMBERS.has(`${owner}/${name}`)
}

export function getWhitelistCatalog(): CatalogCategory[] {
  const byCategory = new Map<string, { model: string; official: boolean }[]>()
  for (const entry of entries) {
    let group = byCategory.get(entry.category)
    if (!group) {
      group = []
      byCategory.set(entry.category, group)
    }
    group.push({ model: entry.model, official: entry.official })
  }
  return [...byCategory.entries()].map(([category, models]) => ({ category, models }))
}
