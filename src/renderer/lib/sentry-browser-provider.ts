// Keep the dynamic boundary tree-shakeable. Importing the package namespace
// through import('@sentry/browser') makes Rollup retain every public export;
// this wrapper exposes only the few primitives the renderer facade uses.
export { addBreadcrumb, captureException, captureMessage, init, setUser } from '@sentry/browser'
