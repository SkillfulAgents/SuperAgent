import type { PluggableList } from 'unified'
import remarkGfm from 'remark-gfm'
import { remarkTrimAutolinkLiteral } from './remark-trim-autolink-literal'

// One stable reference for every agent-prose <ReactMarkdown>: memoized blocks
// bail on identity, so callers must not build a fresh array per render.
export const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkTrimAutolinkLiteral]
