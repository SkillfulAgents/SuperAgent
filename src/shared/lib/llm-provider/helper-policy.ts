/** Safe, actionable configuration errors may be returned to dashboard callers. */
export class HelperConfigurationError extends Error {
  constructor() { super('Choose an API-capable global summarizer in Settings → Model Providers') }
}

type HelperProvider = { supportsDirectApi: boolean }
type HelperSelection = { provider: HelperProvider; connection: { userId: string | null } }
export interface HelperState<T extends HelperSelection> {
  root: T | null
  summarizer: T | null
}

export function assertDirectApiProvider(provider: HelperProvider): void {
  if (provider.supportsDirectApi === false) throw new HelperConfigurationError()
}

export function isHelperSelection<T extends HelperSelection>(selection: T | null | undefined): selection is T {
  return selection != null && selection.connection.userId === null && selection.provider.supportsDirectApi !== false
}

/** Stale overrides inherit only an API-capable global app default. */
export function effectiveHelper<T extends HelperSelection>({ root, summarizer }: HelperState<T>): T | null {
  return isHelperSelection(summarizer) ? summarizer : isHelperSelection(root) ? root : null
}

/** The same invariant applies to explicit settings, provisioning and legacy imports. */
export function assertHelperState<T extends HelperSelection>(state: HelperState<T>): void {
  if ((state.summarizer && !isHelperSelection(state.summarizer)) || (state.root && !effectiveHelper(state))) {
    throw new HelperConfigurationError()
  }
}

/** Do not break working helpers. Already-stale settings must remain editable so
 * credentials/name/catalog repairs don't require repairing everything at once. */
export function assertHelperTransition<T extends HelperSelection>(before: HelperState<T>, after: HelperState<T>): void {
  if (!before.root || effectiveHelper(before)) assertHelperState(after)
}
