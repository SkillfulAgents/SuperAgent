import { useContext, useMemo, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type Options as ReactMarkdownOptions } from 'react-markdown'
import { REMARK_PLUGINS } from '@renderer/lib/remark-plugins'
import { createMarkdownUrlTransform, markdownUrlTransform } from '@renderer/lib/markdown-url-transform'
import { Link, type LinkProps } from '@tanstack/react-router'
import { isAgentPageHref, settingsTabFromHref } from '@renderer/lib/in-app-link'
import { DialogContext } from '@renderer/context/dialog-context'
import { FilePreviewContext } from '@renderer/context/file-preview-context'
import { isSafeWorkspaceFilePath } from '@renderer/lib/workspace-file-url'

// The one place react-markdown is wired: plugins, link-href policy, default anchor.

function workspaceFilePath(href: string): string | null {
  try {
    // Parsed like a workspace image (markdown-url-transform.ts): query and hash are not part of the name.
    const filePath = decodeURIComponent(new URL(href, 'file://').pathname)
    return isSafeWorkspaceFilePath(filePath) ? filePath : null
  } catch {
    return null
  }
}

// Its own component so only workspace links re-render with the preview tray.
function WorkspaceFileLink({ children, href, agentSlug }: { children?: ReactNode; href: string; agentSlug?: string }) {
  const openFile = useContext(FilePreviewContext)?.openFile
  const filePath = workspaceFilePath(href)
  if (!agentSlug || !openFile || !filePath) return <>{children}</>
  return (
    <a
      href={href}
      className="text-blue-500 hover:underline"
      onClick={(event) => {
        event.preventDefault()
        openFile(filePath, agentSlug)
      }}
    >
      {children}
    </a>
  )
}

// target="_blank" is the only path that reaches the Electron shell opener.
export function MarkdownLink({ children, href, agentSlug }: { children?: ReactNode; href?: string; agentSlug?: string }) {
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
  if (href?.startsWith('/workspace/')) {
    return <WorkspaceFileLink href={href} agentSlug={agentSlug}>{children}</WorkspaceFileLink>
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
  /** Enables file:///workspace images through the authenticated workspace route. */
  agentSlug?: string
}

export function Markdown({ children, components, rehypePlugins, imageAliases, agentSlug }: MarkdownProps) {
  const merged = useMemo(() => {
    const defaults: Components = agentSlug
      ? { ...DEFAULT_COMPONENTS, a: (props) => <MarkdownLink {...props} agentSlug={agentSlug} /> }
      : DEFAULT_COMPONENTS
    return components ? { ...defaults, ...components } : defaults
  }, [components, agentSlug])
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
