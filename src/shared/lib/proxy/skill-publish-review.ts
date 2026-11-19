import { z } from 'zod'

/** What a person is shown when an agent asks to publish a skill to a team skillset. */
export const skillPublishReviewSchema = z.object({
  skillName: z.string(),
  skillDirectory: z.string(),
  skillsetName: z.string(),
  /** The description in the skill's SKILL.md, read by the host. */
  description: z.string(),
  /** The agent's own words on what it publishes and why. */
  agentNote: z.string(),
  files: z.array(z.string()),
  /** True when the skillset already has this skill and the publish changes it. */
  updatesPublishedSkill: z.boolean(),
})

export type SkillPublishReview = z.infer<typeof skillPublishReviewSchema>

export function parseSkillPublishReview(value: unknown): SkillPublishReview | undefined {
  const parsed = skillPublishReviewSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
