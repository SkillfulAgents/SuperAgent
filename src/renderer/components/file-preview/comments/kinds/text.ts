import type { AnchorKindSpec } from './types'

export interface TextAnchor {
  kind: 'text'
  quote: string
}

export const textKind: AnchorKindSpec<TextAnchor> = {
  describe: ({ quote }) => `> "${quote}"`,
}
