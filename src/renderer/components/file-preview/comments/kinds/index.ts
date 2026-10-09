import { cellKind } from './cell'
import { pointKind } from './point'
import { textKind } from './text'
import { timeKind } from './time'
import type { AnchorKindSpec } from './types'

/** Default: a comment on the whole file. */
const fileKind: AnchorKindSpec<{ kind: 'file' }, object> = {
  defaultSurface: {},
  fromElsewhere: () => ({ kind: 'file' }),
  describe: () => 'Whole file',
}

/**
 * One spec per kind of anchor. Key order is resolution order: the first kind that
 * resolves wins, and `file` ends every walk. A new kind is its spec file plus a row.
 */
export const ANCHOR_KINDS = {
  cell: cellKind,
  text: textKind,
  time: timeKind,
  point: pointKind,
  file: fileKind,
}

type Specs = typeof ANCHOR_KINDS
export type AnchorKind = keyof Specs
export type AnchorOf<K extends AnchorKind> = Parameters<Specs[K]['describe']>[0]
export type SurfaceOf<K extends AnchorKind> = Specs[K] extends AnchorKindSpec<AnchorOf<K>, infer S> ? S : never

/** Where a comment points in its file. */
export type CommentAnchor = AnchorOf<AnchorKind>

/** What a viewer offers to comment on: each kind's piece, under the kind's name. */
export type CommentSurface = { [K in AnchorKind]?: SurfaceOf<K> }

export type { CellRef } from './cell'
