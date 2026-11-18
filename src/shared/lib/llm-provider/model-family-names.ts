// Acronym families that shouldn't be title-cased (e.g. 'gpt' → 'GPT', not 'Gpt').
const FAMILY_LABELS: Record<string, string> = {
  gpt: 'GPT',
  'gpt-astra': 'GPT Astra',
  'gpt-sol': 'GPT Sol',
  'gpt-terra': 'GPT Terra',
  'gpt-luna': 'GPT Luna',
  glm: 'GLM',
  deepseek: 'DeepSeek',
  'gemini-carbon': 'Gemini Carbon',
  'gemini-argon': 'Gemini Argon',
  'gemini-hydrogen': 'Gemini Hydrogen',
  'muse-wonder': 'Muse Wonder',
  muse: 'Muse Spark',
  'muse-contributor': 'Muse Spark Contributor',
  'muse-ember': 'Muse Ember',
}

/** Display name for a family key, special-casing acronyms. */
export function familyDisplayName(family: string): string {
  return FAMILY_LABELS[family] ?? family.charAt(0).toUpperCase() + family.slice(1)
}
