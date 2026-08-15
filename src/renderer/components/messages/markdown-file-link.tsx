import { type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import { cn } from '@shared/lib/utils/cn'
import { workspaceFilePathFromHref } from '@renderer/lib/workspace-file-url'
import { useFilePreview } from '@renderer/context/file-preview-context'

const LINK_CLASS = cn('hover:underline', 'text-blue-500')

function MarkdownAnchor({
  children,
  href,
  onActivate,
}: {
  children?: ReactNode
  href?: string
  onActivate?: () => void
}) {
  if (onActivate) {
    return (
      <button
        type="button"
        className={cn(LINK_CLASS, 'cursor-pointer border-0 bg-transparent p-0 font-[inherit]')}
        onClick={onActivate}
      >
        {children}
      </button>
    )
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={LINK_CLASS}
    >
      {children}
    </a>
  )
}

function MarkdownFileLink({
  children,
  href,
  agentSlug,
}: {
  children?: ReactNode
  href?: string
  agentSlug: string
}) {
  const { openFile } = useFilePreview()
  const filePath = workspaceFilePathFromHref(href)
  if (filePath) {
    return (
      <MarkdownAnchor onActivate={() => openFile(filePath, agentSlug)}>
        {children}
      </MarkdownAnchor>
    )
  }
  return <MarkdownAnchor href={href}>{children}</MarkdownAnchor>
}

/** Override only `a`. Callers that already customize other tags should spread this last. */
export function markdownLinkComponents(agentSlug?: string): Pick<Components, 'a'> {
  if (!agentSlug) {
    return {
      a: ({ children, href }) => (
        <MarkdownAnchor href={href}>{children}</MarkdownAnchor>
      ),
    }
  }
  return {
    a: ({ children, href }) => (
      <MarkdownFileLink href={href} agentSlug={agentSlug}>
        {children}
      </MarkdownFileLink>
    ),
  }
}
