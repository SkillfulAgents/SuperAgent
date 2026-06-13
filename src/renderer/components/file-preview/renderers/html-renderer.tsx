interface HtmlRendererProps {
  url: string
}

export function HtmlRenderer({ url }: HtmlRendererProps) {
  return (
    <iframe
      src={url}
      sandbox="allow-scripts"
      title="HTML preview"
      className="w-full h-full border-0"
      style={{ minHeight: '100%' }}
    />
  )
}
