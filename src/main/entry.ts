// The main process's entry point (`dist/main/index.js`). It turns V8's compile
// cache on and then loads the app, which is built as its own file beside it
// (`dist/main/main.js`, from `index.ts`).
//
// Keep this file tiny and its imports to Electron and Node built-ins: the
// cache only covers modules loaded after it is on, and an import here is
// loaded before. The app is loaded with a runtime `require`, not an `import`,
// for the same reason: an import would be bundled into this file and its
// dependencies hoisted above the call.
//
// Nothing here may read a path that depends on the app's name (`userData`,
// `sessionData`, `logs`, …): Electron resolves those once, on first read, and
// `index.ts` has not set the name yet. `startMainCompileCache` takes an `app`
// that can only be asked for `home`; `compile-cache.test.ts` pins the rest.
import { app } from 'electron'
import { startMainCompileCache } from './compile-cache'

startMainCompileCache(app, __dirname)

require('./main.js')
