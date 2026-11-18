// The main process's entry point (`dist/main/index.js`). It turns V8's compile
// cache on and then loads the app, which is built as its own file beside it
// (`dist/main/main.js`, from `index.ts`).
//
// Keep this file tiny and its imports to Electron and Node built-ins: the
// cache only covers modules loaded after it is on, and an import here is
// loaded before. The app is loaded with a runtime `require`, not an `import`,
// for the same reason: an import would be bundled into this file and its
// dependencies hoisted above the call.
import { app } from 'electron'
import { compileCacheBaseDir, enableMainCompileCache } from './compile-cache'

const cacheDir = compileCacheBaseDir({
  isPackaged: app.isPackaged,
  userData: app.getPath('userData'),
  entryDir: __dirname,
})
if (cacheDir) enableMainCompileCache(cacheDir)

require('./main.js')
