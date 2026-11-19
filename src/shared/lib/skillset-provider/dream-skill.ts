import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import type { ApiSkillWithStatus } from '@shared/lib/types/api'

export const DREAM_SKILL_PATH = 'skills/dream/SKILL.md'

export function isPublicDreamSkill(skill: ApiSkillWithStatus) {
  return skill.status.skillsetId === DEFAULT_PUBLIC_SKILLSET.id && skill.name.toLowerCase() === 'dream'
}

// Dream's Setup mode asks for cadence and focus before it creates its recurring task.
export const DREAM_SETUP_PROMPT = 'Use the /dream skill to set up dreaming. Ask me when it should run and what to focus on, then schedule it and run the first dream.'
