// Acronym families that shouldn't be title-cased (e.g. 'gpt' → 'GPT', not 'Gpt').
const FAMILY_LABELS: Record<string, string> = {
  gpt: 'GPT',
  'gpt-astra': 'GPT Astra',
  'gpt-sol': 'GPT Sol',
  'gpt-terra': 'GPT Terra',
  'gpt-luna': 'GPT Luna',
  glm: 'GLM',
  deepseek: 'DeepSeek',
  'gemini-argon': 'Gemini Argon',
  'muse-wonder': 'Muse Wonder',
  muse: 'Muse Spark',
  'muse-contributor': 'Muse Spark Contributor',
}

/** Display name for a family key, special-casing acronyms. */
export function familyDisplayName(family: string): string {
  return FAMILY_LABELS[family] ?? family.charAt(0).toUpperCase() + family.slice(1)
}
