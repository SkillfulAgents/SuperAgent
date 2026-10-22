/**
 * Every experiment the app offers, in the order Settings → Experiments lists
 * them. See `./index.ts` for how to add, gate and retire one.
 */
export interface ExperimentDefinition {
  /** Stable key in user settings. Never reuse an id for a different feature. */
  id: string
  /** Shown as the switch's label. */
  name: string
  /** One or two sentences: what turning it on adds, and where to find it. */
  description: string
}

export const EXPERIMENTS = [
  {
    id: 'todo-board',
    name: 'Todo board',
    description: 'Adds Todo to the sidebar: a board where you write down tasks, hand them to agents, and follow what is working, what needs your input, and what is done.',
  },
  {
    id: 'team-brain',
    name: 'Team Brain',
    description: 'Adds Team Brain to the sidebar: a shared wiki an agent builds from your Slack, Notion, Drive and more, mounted as a drive on every agent. Prototype: the landing page and set-up modal only; nothing is created yet.',
  },
] as const satisfies readonly ExperimentDefinition[]
