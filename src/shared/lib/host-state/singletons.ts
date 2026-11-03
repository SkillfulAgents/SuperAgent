/**
 * Host files made once and never rewritten (a key, an id), with their
 * creators. No imports: modules that error reporting loads register here.
 */
const singletons = new Map<string, () => string>()

export function defineSingletonHostFile(name: string, create: () => string): void {
  singletons.set(name, create)
}

export function singletonHostFiles(): ReadonlyMap<string, () => string> {
  return singletons
}
