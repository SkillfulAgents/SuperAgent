/**
 * Branded Gamut package file extensions — single source of truth for the
 * main-process open-file router, the renderer import dialogs, and the export
 * endpoints. (package.json's electron-builder `fileAssociations` block can't
 * import this; keep it in sync when changing these.)
 *
 * Both formats are plain zips: an agent template carries a root CLAUDE.md, a
 * skill a root SKILL.md. The extension is only ever a routing/ordering hint —
 * import pipelines validate by zip content, never by filename.
 */
export const AGENT_PACKAGE_EXTENSION = '.agent'
export const SKILL_PACKAGE_EXTENSION = '.skill'

/** Opening one of these routes to the import flow instead of file attach. */
export function isImportPackagePath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return lower.endsWith(AGENT_PACKAGE_EXTENSION) || lower.endsWith(SKILL_PACKAGE_EXTENSION)
}

/**
 * Verdict for an opened package, produced by the main process (which classifies
 * from disk) and consumed across the preload bridge by the renderer import
 * dialogs. Either a kind was established from the zip content, or classification
 * failed with a user-presentable error — never both.
 */
export type ClassifiedImportPackage =
  | { path: string; fileName: string; kind: 'agent-template' | 'skill'; name: string | null }
  | { path: string; fileName: string; error: string }
