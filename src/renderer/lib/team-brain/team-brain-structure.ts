import type { TeamBrainSourceId } from './team-brain-schema'

/** A page or folder in Team Brain's drive, as the home page's tree draws it. */
export interface TeamBrainNode {
  /** Stable id, used for include/exclude and as a React key. */
  id: string
  name: string
  kind: 'folder' | 'file'
  /** One line on what lives here. */
  summary?: string
  /** Which connected sources feed this node. Empty = Team Brain's own. */
  sources: TeamBrainSourceId[]
  children?: TeamBrainNode[]
  /** Live-state decoration: how long ago Team Brain last touched it, in minutes. */
  updatedMinutesAgo?: number
  /** A folder the tree shows folded: how many items it holds. */
  hidden?: number
  /** A "+N more" page: the names of the pages it stands for. */
  more?: string[]
  /** A "+N more" page that opens its folder in the tree rather than listing the pages. */
  expands?: string
}
