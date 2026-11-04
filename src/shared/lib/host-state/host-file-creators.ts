/**
 * Creators of the host files made on first use and never rewritten (a key, an
 * id). No imports: modules that error reporting loads register here at import
 * time, while host-files.ts may still be loading.
 */
const creators = new Map<string, () => string>()

export function defineHostFileCreator(name: string, create: () => string): void {
  creators.set(name, create)
}

export function hostFileCreators(): ReadonlyMap<string, () => string> {
  return creators
}
