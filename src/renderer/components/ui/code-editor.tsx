import { lazy, Suspense } from 'react'
import type { OnMount } from '@monaco-editor/react'

import { useIsDark } from '@renderer/hooks/use-theme'

// Load the locally configured editor only when a file is opened. The default
// Monaco loader fetches a CDN build with its own, unpatched DOMPurify copy.
const Editor = lazy(() => import('./local-monaco-editor'))

interface CodeEditorProps {
  value: string
  onChange?: (value: string) => void
  language?: string
  readOnly?: boolean
  className?: string
}

export function CodeEditor({ value, onChange, language, readOnly, className }: CodeEditorProps) {
  const isDark = useIsDark()
  const loading = (
    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
      Loading editor...
    </div>
  )

  const handleMount: OnMount = (editor) => {
    editor.updateOptions({
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      fontSize: 13,
      lineNumbers: 'on',
      readOnly: readOnly ?? false,
      automaticLayout: true,
    })
  }

  return (
    <div className={className}>
      <Suspense fallback={loading}>
        <Editor
          value={value}
          onChange={(val) => onChange?.(val ?? '')}
          language={language}
          theme={isDark ? 'vs-dark' : 'vs'}
          onMount={handleMount}
          loading={loading}
        />
      </Suspense>
    </div>
  )
}
