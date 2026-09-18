import type { Link, PhrasingContent, Root, Text } from 'mdast'
import type { Point, Position } from 'unist'
import { SKIP, visit } from 'unist-util-visit'
import { splitUrlTrail } from './url-trail'

// GFM's autolink-literal only trims ASCII trailing punctuation, so a bare URL
// glued to fullwidth punctuation — `**https://x.com**（public）。` — keeps
// `**（public）。` in the href and eats the closing `**`, which leaves the opening
// `**` as literal text. This runs after remark-gfm, hands the trail back to the
// prose, and rebuilds the emphasis the swallowed delimiter was meant to close.

const EMPHASIS_DELIMITER = /^(\*\*|__|\*|_)/

// Autolinks never span lines, so a shift stays on the start point's line.
function shiftPoint(point: Point, delta: number): Point {
  return {
    line: point.line,
    column: point.column + delta,
    offset: point.offset === undefined ? undefined : point.offset + delta,
  }
}

function span(position: Position | undefined, from: number, to: number): Position | undefined {
  if (!position) return undefined
  return { start: shiftPoint(position.start, from), end: shiftPoint(position.start, to) }
}

function isAutolinkLiteral(node: Link): node is Link & { children: [Text] } {
  const [child] = node.children
  return node.children.length === 1 && child.type === 'text' && node.url.endsWith(child.value)
}

export function remarkTrimAutolinkLiteral() {
  return (tree: Root) => {
    visit(tree, 'link', (node, index, parent) => {
      if (index === undefined || !parent || !isAutolinkLiteral(node)) return
      const [text] = node.children
      const { url, trail } = splitUrlTrail(text.value)
      if (!trail || !url) return

      const originalLength = text.value.length
      text.value = url
      node.url = node.url.slice(0, node.url.length - trail.length)
      const linkPosition = node.position
      const linkSpan = span(linkPosition, 0, url.length)
      node.position = linkSpan
      text.position = linkSpan

      let restStart = url.length
      let rest = trail
      let replacement: PhrasingContent = node
      const previous = parent.children[index - 1]
      const delimiter = EMPHASIS_DELIMITER.exec(trail)?.[1]
      if (delimiter && previous?.type === 'text' && previous.value.endsWith(delimiter)) {
        previous.value = previous.value.slice(0, -delimiter.length)
        if (previous.position) previous.position.end = shiftPoint(previous.position.end, -delimiter.length)
        rest = trail.slice(delimiter.length)
        restStart += delimiter.length
        replacement = {
          type: delimiter.length === 2 ? 'strong' : 'emphasis',
          children: [node],
          position: span(linkPosition, -delimiter.length, restStart),
        }
      }

      const inserted: PhrasingContent[] = [replacement]
      if (rest) {
        inserted.push({ type: 'text', value: rest, position: span(linkPosition, restStart, originalLength) })
      }
      parent.children.splice(index, 1, ...inserted)
      let next = index + inserted.length
      if (previous?.type === 'text' && previous.value === '') {
        parent.children.splice(index - 1, 1)
        next--
      }
      return [SKIP, next]
    })
  }
}
