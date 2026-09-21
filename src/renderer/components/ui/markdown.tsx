import { useMemo } from 'react'
import ReactMarkdown, { type Components, type Options as ReactMarkdownOptions } from 'react-markdown'
import { REMARK_PLUGINS } from '@renderer/lib/remark-plugins'
import { createMarkdownUrlTransform, markdownUrlTransform } from '@renderer/lib/markdown-url-transform'

// The one place react-markdown is wired: plugins, link-href policy, default anchor.

// target="_blank" is the only path that reaches the Electron shell opener.
const DEFAULT_COMPONENTS: Components = {
  a: function MarkdownLink({ children, href }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
        {children}
      </a>
    )
  },
}

export interface MarkdownProps {
  children: string
  /** Merged over the defaults. Pass a module-level reference so memoized blocks bail. */
  components?: Components
  rehypePlugins?: ReactMarkdownOptions['rehypePlugins']
  /** Exact container paths proven to belong to image blocks in tool results. */
  imageAliases?: ReadonlyMap<string, string>
  /** Enables file:///workspace images through the authenticated workspace route. */
  agentSlug?: string
}

export function Markdown({ children, components, rehypePlugins, imageAliases, agentSlug }: MarkdownProps) {
  const merged = useMemo(
    () => (components ? { ...DEFAULT_COMPONENTS, ...components } : DEFAULT_COMPONENTS),
    [components]
  )
  const urlTransform = useMemo(
    () => (imageAliases || agentSlug ? createMarkdownUrlTransform({ aliases: imageAliases, agentSlug }) : markdownUrlTransform),
    [imageAliases, agentSlug]
  )
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehypePlugins} components={merged} urlTransform={urlTransform}>
      {children}
    </ReactMarkdown>
  )
}
