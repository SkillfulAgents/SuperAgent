// Keep the dynamic boundary tree-shakeable. Importing the package namespace
// through import('@sentry/browser') makes Rollup retain every public export;
// this wrapper exposes only the primitives the renderer facade uses.
export { addBreadcrumb, captureException, init, setUser } from '@sentry/browser'
