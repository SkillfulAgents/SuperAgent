import { createElement, useContext, useMemo, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type Options as ReactMarkdownOptions } from 'react-markdown'
import { REMARK_PLUGINS } from '@renderer/lib/remark-plugins'
import { createMarkdownUrlTransform, hasUrlScheme, markdownUrlTransform } from '@renderer/lib/markdown-url-transform'
import { Link, type LinkProps } from '@tanstack/react-router'
import { isAgentPageHref, settingsTabFromHref } from '@renderer/lib/in-app-link'
import { DialogContext } from '@renderer/context/dialog-context'
import { AgentFileOpenerContext } from '@renderer/context/agent-file-opener-context'
import { isFolderPath } from '@shared/lib/utils/workspace-path'

// The one place react-markdown is wired: plugins, link-href policy, default anchor.

// A file link keeps the file's real URL, so a middle-click or a copied link still gets the file.
function AgentFileLink({ children, href, filePath, agentSlug }: { children?: ReactNode; href: string; filePath: string; agentSlug: string }) {
  const opener = useContext(AgentFileOpenerContext)
  if (isFolderPath(filePath)) {
    if (!opener) return <>{children}</>
    const open = () => opener.openFolder(filePath, agentSlug)
    // Inline text, not a button: a button never wraps, so text after it at the end of a line drops to its own line.
    return (
      <span
        role="button"
        tabIndex={0}
        className="cursor-pointer text-blue-500 hover:underline"
        onClick={open}
        onKeyDown={(event) => { if (event.key === 'Enter') open() }}
      >
        {children}
      </span>
    )
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-500 hover:underline"
      onClick={opener ? (event) => {
        // A modifier-click keeps the browser's own handling: a new tab or window gets the file.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        opener.openFile(filePath, agentSlug)
      } : undefined}
    >
      {children}
    </a>
  )
}

// target="_blank" is the only path that reaches the Electron shell opener.
export function MarkdownLink({ children, href }: { children?: ReactNode; href?: string }) {
  const openSettings = useContext(DialogContext)?.openSettings
  if (href?.startsWith('/agents/')) {
    if (!isAgentPageHref(href)) return <>{children}</>
    // Link, not AppLink: AppLink imports the router singleton, which would pull every route into Markdown.
    return (
      <Link to={href as LinkProps['to']} className="text-blue-500 hover:underline">
        {children}
      </Link>
    )
  }
  const settingsTab = settingsTabFromHref(href)
  if (settingsTab && openSettings) {
    return (
      <a
        href={href}
        className="text-blue-500 hover:underline"
        onClick={(event) => {
          event.preventDefault()
          openSettings(settingsTab)
        }}
      >
        {children}
      </a>
    )
  }
  // A path with no scheme that nothing above claimed would open a blank page of this app.
  if (!href || !(hasUrlScheme(href) || href.startsWith('//'))) return <>{children}</>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
      {children}
    </a>
  )
}

const DEFAULT_COMPONENTS: Components = {
  a: MarkdownLink,
}

export interface MarkdownProps {
  children: string
  /** Merged over the defaults. Pass a module-level reference so memoized blocks bail. */
  components?: Components
  rehypePlugins?: ReactMarkdownOptions['rehypePlugins']
  /** Exact container paths proven to belong to image blocks in tool results. */
  imageAliases?: ReadonlyMap<string, string>
  /** Opts in to this agent's files. See MarkdownImageContext. */
  agentSlug?: string
  /** Opts in to relative paths, resolved from this folder. See MarkdownImageContext. */
  folder?: string
}

export function Markdown({ children, components, rehypePlugins, imageAliases, agentSlug, folder }: MarkdownProps) {
  const { merged, urlTransform } = useMemo(() => {
    const base = components ? { ...DEFAULT_COMPONENTS, ...components } : DEFAULT_COMPONENTS
    if (!agentSlug) {
      return { merged: base, urlTransform: imageAliases ? createMarkdownUrlTransform({ aliases: imageAliases }) : markdownUrlTransform }
    }
    // The URL step records each file link it makes, so the anchor opens that path without resolving it again.
    const agentFileLinks = new Map<string, string>()
    const a: Components['a'] = (props) => {
      const filePath = props.href === undefined ? undefined : agentFileLinks.get(props.href)
      // Claimed before a caller's anchor, so a caller's link handler never sees a file link.
      if (props.href !== undefined && filePath !== undefined) {
        return <AgentFileLink href={props.href} filePath={filePath} agentSlug={agentSlug}>{props.children}</AgentFileLink>
      }
      return createElement(base.a ?? MarkdownLink, props)
    }
    return {
      merged: { ...base, a },
      urlTransform: createMarkdownUrlTransform({ aliases: imageAliases, agentSlug, folder, agentFileLinks }),
    }
  }, [components, imageAliases, agentSlug, folder])
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehypePlugins} components={merged} urlTransform={urlTransform}>
      {children}
    </ReactMarkdown>
  )
}
