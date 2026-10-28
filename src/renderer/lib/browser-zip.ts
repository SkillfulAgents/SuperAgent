// Keep the dynamically loaded browser-upload chunk tree-shaken to the one
// fflate primitive we use. Importing the package namespace pulls every export.
export { zip } from 'fflate'
