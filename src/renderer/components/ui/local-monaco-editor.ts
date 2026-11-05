import Editor, { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker.js?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker'
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker.js?worker'

// Bundle workers with the app so skill files also open without CDN access.
self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    switch (label) {
      case 'json': return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less': return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor': return new HtmlWorker()
      case 'typescript':
      case 'javascript': return new TypeScriptWorker()
      default: return new EditorWorker()
    }
  },
}

loader.config({ monaco })

export default Editor
