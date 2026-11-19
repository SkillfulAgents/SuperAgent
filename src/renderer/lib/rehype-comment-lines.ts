import type { Element, Root } from 'hast'

/** Blocks a comment can point at, each stamped with the source lines it came from. */
const BLOCKS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'th', 'td', 'pre'])

function stamp(node: Root | Element) {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    const position = child.position
    if (BLOCKS.has(child.tagName) && position) {
      child.properties.dataCommentLines = `${position.start.line}-${position.end.line}`
      // A lone text child renders as the element's text content, which an update overwrites,
      // taking the comment pin drawn inside with it. A span keeps the text apart.
      const [only] = child.children
      if (child.children.length === 1 && only.type === 'text') {
        child.children = [{ type: 'element', tagName: 'span', properties: {}, children: [only] }]
      }
    }
    stamp(child)
  }
}

/** Rehype plugin: `data-comment-lines="start-end"` on each block, for comments on a markdown file. */
export function rehypeCommentLines() {
  return (tree: Root) => stamp(tree)
}
